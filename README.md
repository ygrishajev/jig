# jig

An agentic SDLC pipeline orchestrator. It turns a markdown request into
reviewed, merge-ready commits by driving an agentic coding CLI (e.g.
[Claude Code](https://claude.com/claude-code)) through a fixed pipeline:
plan the feature, slice it into small reviewable units, then for each
slice — implement, review, verify, repeat. Every slice lands on one run branch, and jig
writes its pull request description; you merge it, or jig does with `mergeMode: "auto"`.

Agents run unattended inside a [sandcastle](https://github.com/mattpocock/sandcastle)
Docker sandbox, one per run. The current design is in
[the sandcastle migration spec](docs/superpowers/specs/2026-10-29-sandcastle-migration-design.md);
the whole run is defined in one place, [`src/flow/run-flow.ts`](src/flow/run-flow.ts).

## Install

```bash
npm install
npm run build
npm link   # or: node dist/cli/main.js <command>
npx husky  # git hooks for contributing; .npmrc turns off the install scripts that would set them up
```

Requires Node >=20, Docker running locally, and git 2.38 or newer (jig checks merges with
`git merge-tree --write-tree`). Run jig from the repository's root. Agents commit inside the
sandbox as `jig`; the final merge is made on the host with your git identity, so `user.name` and
`user.email` must be set. Agent commits are unsigned unless you set `commitSigning: "repo"`, and
then your signing setup must work without a prompt.

### Installing from another repo

`jig` publishes as `@ygrishajev/jig` to GitHub Packages (private npm
registry) on every `vX.Y.Z` tag push — see
[`.github/workflows/publish.yml`](.github/workflows/publish.yml). It stays
a private repo; only accounts with read access to it can install the
package.

In the consuming repo, add an `.npmrc`:

```
@ygrishajev:registry=https://npm.pkg.github.com
```

Then install with a token that has `read:packages` scope (a classic PAT —
GitHub Packages needs a token even for repos you own):

```bash
npm install @ygrishajev/jig
```

In CI, set `NODE_AUTH_TOKEN` to that token before `npm install` (e.g. a
repo secret), same as `registry-url` in `actions/setup-node`.

## Quickstart

In the repository you want jig to work on:

```bash
jig init                            # asks for agents and any missing credentials, writes the Dockerfile + config, checks them in the sandbox
git add .sandcastle jig.config.json && git commit -m "set up jig"
jig run request.md                  # plan, implement, review, verify, describe, merge
```

## Commands

| Command                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jig init [--no-agent]`            | Writes `.sandcastle/Dockerfile`, its `.gitignore` and a starter `jig.config.json`. Steps with no agent are asked for in a terminal: select agents and models, then assign them to steps if there are several; with no answer, or outside a terminal, it stops and says what to set. Once every step has an agent (and without `--no-agent`), the planner fills in the toolchain and `setupCommand`/`verifyCommand`, and they are accepted only once both pass inside the sandbox (up to 3 attempts). |
| `jig build [--pull-agents]`        | Builds the sandbox image if the Dockerfile or the agents changed. `run` does this too. Needs every step's agent set.                                                                                                                                                                                                                                                                                                                                                                                 |
| `jig run [request.md] [--id <id>]` | Starts a run from a request file, or resumes one by id. With both, it resumes only if the file is the request the run started with. Without `--id`, a new run is named after the request's first `# heading` (or its file name), e.g. `add-retry-backoff-3f9a1c2e`.                                                                                                                                                                                                                                  |
| `jig status <id>`                  | Where a run is, its slices and feedback, and its cost so far.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `jig presets`                      | Lists the presets `--preset` can name, where each is read from, and its description.                                                                                                                                                                                                                                                                                                                                                                                                                 |

`run` stops (exit 0) when the work is merged, waits for a manual merge, pauses at the design
checkpoint, blocks, or gets stuck; `result.json` says which. Resume with `jig run --id <id>`.
A stuck run is over: a slice hit `reviewCycleCap`, the run was still described, and
`jig run --id` returns it as it is without starting a sandbox. Finish the work by hand on its
branch (`jig status <id>` shows the reviewer's feedback, `PR_DESCRIPTION.md` the description),
or start a new run. A finished run is likewise returned as it is.
A resumed run sees a merge done by hand, whether plain, squash or rebase, and checks the base
branch's remote too, so it is seen before the operator pulls it. One process at a time runs a
given run: a second `jig run --id` for it fails at once, and a lock left by a crashed process
expires after 30 seconds.

## The sandbox

- **One sandbox per run.** Every agent call and the verify command run in the same container,
  over a worktree sandcastle keeps for the run branch `jig/run/<id>`.
- **Image.** `.sandcastle/Dockerfile` is the repository's: base tools, then the project's
  toolchain between the marked lines. jig adds a layer with the agent CLIs the config uses, at
  exact versions, built per machine with your UID. Labels on the image decide what to rebuild.
- **Setup.** `setupCommand` runs once in the new sandbox and must exit 0 within
  `setupTimeoutSeconds`. In a run, a sandbox that fails to start or a failing `setupCommand` is
  tried twice more; a configuration problem such as missing credentials stops the run at once.
  `init` hands a failing `setupCommand` or `verifyCommand` back to the planner, and stops on
  anything else.
- **Credentials** come from the environment, or from `.jig/.env` when a variable is not set there,
  and go into the container as env vars. `jig init` asks for missing ones in a terminal and offers
  to save them to that file, which git ignores and only you can read; `jig run` and everything
  outside a terminal stop before building, naming what to set:
  claude needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; opencode needs its provider's
  key, e.g. `OPENROUTER_API_KEY` for an `openrouter/...` model; codex needs `JIG_CODEX_AUTH_DIR`,
  the folder holding a saved ChatGPT login (`auth.json`), usually `~/.codex` — the one exception to env-only
  credentials, described under [Live E2E](#live-e2e). Sandcastle also injects every
  key listed in `.sandcastle/.env`, if the repository has one; jig warns with their names.
- **What the sandbox sees.** A private clone of the run and base branches, with no remote and
  nothing from the repository mounted. Commits reach the host as a bundle after each implement step,
  so work on other branches and `.git/config` stay out of the sandbox's reach. Only the Codex login
  directory is mounted, when codex is configured.
- **Automatic merges.** `mergeMode: "auto"` lands agent code nobody has read, so only use it where
  you accept that. jig turns git hooks off for its own merge, so your `post-merge` hooks do not run.

## Configuration

`jig.config.json` in the repository root (strict: unknown keys are errors).

Every command takes `--config <path>` to read another file instead, e.g. a preset per kind of
run: `jig run request.md --config jig.config.cheap.json`. The path is relative to the
repository root, and a named file must exist. Pass the same `--config` again when resuming.

`jig run` and `jig build` also take `--preset <name>`, which swaps in another set of agents
without editing the config: `jig run request.md --preset cheap`. A preset is `<name>.json` in
`.jig/presets/` of the repository, `~/.jig/presets/`, `$XDG_CONFIG_HOME/jig/presets/`
(`~/.config` when unset), or the starters that ship with jig (source `builtin`), searched in that
order; the first file with the name wins, even when it is broken, so your own file of a starter's
name replaces that starter. It holds only an optional `description` and any of `planner`, `implementer`,
`reviewer` and `describer`; each step it names replaces the config's step whole, so a model never
carries over to another provider, and every other setting stays the config's. Names are
lowercase letters and digits joined by single hyphens. Pass the same `--preset` again when
resuming.

`--preset` with no name asks which preset to use: `jig build --preset`. The list starts with
`jig.config.json (no preset)`, which keeps the config's own agents, then every preset found,
showing the highlighted one's description; a preset that is not a starter has its source beside
its name, e.g. `long-claude (home)`. The pick then works exactly as if you had passed that name.
With no terminal to ask in, a cancelled prompt, or no presets at all, the command stops and asks
for `--preset <name>`. Put a bare `--preset` after the request file, or it reads the file as the
preset's name: `jig run request.md --preset`.

The starters, each naming all four steps:

- `full-power` — subscriptions, best quality, spends Claude most.
- `full-power-codex` — subscriptions, best quality, spends Codex most.
- `long-claude` — subscriptions, many slices; Sonnet implements to stretch the Claude window.
- `codex-only` — Claude is out of limits.
- `claude-only` — Codex is out of limits.
- `cheap-volume` — pay-per-token: an open-weight implementer on OpenRouter, a strong reviewer.
- `open-weight` — both subscriptions are out; OpenRouter open-weight models, simpler requests only.

`gpt-6-astra` (used by `full-power` and `codex-only`) may not be in every Codex plan; if yours
lacks it, copy the starter to `~/.jig/presets/` under the same name with `gpt-6.1-sol` in its place.

| Key                                               | Default                      |                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planner`, `implementer`, `reviewer`, `describer` | — (required to run or build) | Agent per step: `claude`, `opencode` or `codex`; `model` optional for claude (default `opus`), required for opencode (`provider/model`) and codex.                        |
| `setupCommand` / `setupTimeoutSeconds`            | — / `900`                    | Runs once in the sandbox before any agent, e.g. `npm ci`.                                                                                                                 |
| `verifyCommand`                                   | —                            | Must pass in the sandbox before a reviewed slice is approved.                                                                                                             |
| `mergeMode`                                       | `"manual"`                   | `auto` merges the run branch at the end.                                                                                                                                  |
| `designGate`                                      | `"auto"`                     | `checkpoint` pauses after planning.                                                                                                                                       |
| `reviewCycleCap`                                  | `3`                          | Rejections before a slice is stuck.                                                                                                                                       |
| `commitSigning`                                   | `"skip"`                     | `repo` signs the run branch when jig merges it (automatic merges only).                                                                                                   |
| `sandboxImage`                                    | —                            | Use this image as-is instead of building one.                                                                                                                             |
| `agents`                                          | `{}`                         | Pin agent CLI versions, e.g. `{ "claude": "2.1.312" }`.                                                                                                                   |
| `agentUpdates`                                    | `"auto"`                     | `warn` or `off`; how unpinned agents follow new releases.                                                                                                                 |
| `agentIdleTimeoutSeconds`                         | `600`                        | An agent silent this long is stopped.                                                                                                                                     |
| `runStores`                                       | `["local"]`                  | Add `"git-remote"` to push state (hidden `refs/jig/<id>`) and the run branch to `origin`, so another machine can resume; or a path to a module exporting a store factory. |

## CI and observability

- `--log-format json` (default when not a TTY); every run also logs to `.jig/<id>/state/run.log`.
- Run state is saved to every store in `runStores`, and `run` and `status` read the freshest
  copy (the one saved most often). `status` only looks: it never moves a local branch or ref,
  where `run` brings a stale run branch up to date with `origin`. A store module default-exports
  `({ repoRoot }) => ({ load(runId), save(state), peek?(runId) })`; `peek` is the read `status`
  uses and falls back to `load`, and whatever a module store returns is checked as a run. Everything else in `.jig/<id>/state/` is this machine's own
  record of the invocations it ran and is never pushed.
- `.jig/<id>/state/result.json`: `status`, `complete`, `blockedReason`, and `metrics`
  (cost, tokens, durations, review rounds). It is written, with `design.md`, `plan.md`,
  `design-review.md` and `PR_DESCRIPTION.md` (whose footer is the same summary), each time
  `jig run` stops; `metrics.jsonl` has one line per step and agent call, the design reviewer's
  and planner's included.
- `design.md` and `plan.md` are the current documents, revised if the design review asked for
  it. `design-review.md` shows how far the review got, each review's findings with their
  evidence and uncertainty, the planner's dispositions, the documents as first reviewed, and
  the decisions left for the operator; a review still pending never reads as approved. A run
  the review blocked names its unresolved findings in `blockedReason`, which `jig status`
  shows from the saved run on any machine, even one without these files.
- `JIG_IMAGE_CACHE=gha` builds through buildx with the GitHub Actions cache.
- `OTEL_EXPORTER_OTLP_ENDPOINT` exports the run as an OpenTelemetry trace and turns on
  Claude Code's own telemetry in the sandbox. Every `OTEL_*` variable goes into the sandbox
  with it, `OTEL_EXPORTER_OTLP_HEADERS` included, and the endpoint must be reachable from
  inside the container (`localhost` there is the container).

## Development

Development and CI use Node 26.13.0, pinned in `package.json` through Volta.

Run all validations concurrently, with each check's stdout and stderr printed together
when it finishes. Failed checks do not cancel the others; any failure makes the command fail.
The default includes coverage (which runs the test suite) and the slow mutation check.

```bash
npm run validate
npm run validate -- --skip test:mutation
npm run validate -- lint typecheck
npm run validate -- --skip test:mutation test:coverage
npm run validate -- --help
```

```bash
npm test              # fast suite
npm run lint
npm run lint:duplication # jscpd, production source only
npm run test:coverage    # Vitest V8, text + HTML + LCOV
npm run format:check
npm run test:mutation # StrykerJS, slow (~30 min)
npm run secretlint
```

Lint checks production functions for cyclomatic complexity above 10 (errors) and
cognitive complexity above 15 (errors), using ESLint and SonarJS respectively.
Duplication checks fail when jscpd finds duplicated production code with its default clone
size settings; specs are excluded. Reports go to `reports/duplication/`, and coverage reports
go to `coverage/`. Stryker remains the mutation-testing tool.

`vitest.workspace.ts` defines the named `unit` and `e2e` projects. The root config
loads `vitest.unit.workspace.ts` by default, including for mutation testing.
`npm test`, coverage, and watch also select `unit` explicitly. The E2E script selects
the full workspace with `--workspace vitest.workspace.ts --project e2e`.

### Live E2E

`npm run test:e2e` builds the CLI, then runs `tests/e2e/feature.spec.ts` through a
named `e2e` Vitest project for one real pipeline in a fresh temporary
repository. It uses credentials from the environment, with optional defaults from
the ignored `tests/e2e/.env`. It is opt-in and is not part of `npm test` or `validate`.
Docker must be running; the check builds an image and makes paid/subscription agent calls.
The script loads that file with `--env-file-if-exists`, which needs Node 22.9 or newer.

Copy `tests/e2e/.env.example` to `tests/e2e/.env` and fill in the desired credentials
and models before running the check.

Available agents are assigned in order across planner, implementer, reviewer, and describer:
Claude, OpenCode via OpenRouter, then Codex. With all three available, Claude plans and
describes, OpenCode implements, and Codex reviews. With fewer available, roles reuse them.

- Claude: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; model defaults to `haiku`,
  overridable with `JIG_E2E_CLAUDE_MODEL`.
- OpenRouter: `OPENROUTER_API_KEY` and `JIG_E2E_OPENROUTER_MODEL=openrouter/<model>`
  (falls back to `OPENCODE_MODEL`).
- Codex: set `JIG_E2E_CODEX_MODEL` (the sample uses `gpt-6-luna`). Prefer an explicit
  `JIG_CODEX_AUTH_DIR` containing a dedicated `auth.json`. Otherwise, the E2E discovers
  `$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`. This intentionally depends
  on an existing machine login. A discovered full login enables Codex automatically.
  The full ChatGPT token bundle is required, including ID, access, refresh, and account
  fields; extracting `tokens.access_token` into `CODEX_ACCESS_TOKEN` does not work here.
  A missing file or a non-subscription login leaves Codex unavailable; malformed files
  fail setup without printing their contents. Keychain-only logins are not supported.

Codex authentication is an explicit exception to the usual env-only credential rule.
The production CLI accepts the auth directory through `JIG_CODEX_AUTH_DIR`; it does not
auto-discover a host login. The adapter locks that login, creates a private temporary
directory with only `auth.json` (file mode 0600), and mounts the directory writable at
`/home/agent/.codex`. No other host Codex configuration or sessions are mounted. Codex
can refresh credentials normally. After the sandbox closes, valid refreshed credentials
are atomically written back to the selected cache, and the private copy is removed.
If the source login changed meanwhile, it is preserved and the private cache is retained
with an error rather than overwriting the newer login. Credentials never enter repository
artifacts, logs, or Docker image layers. Do not share a login across concurrent jobs or
machines; jig's lock cannot coordinate with independent Codex clients.

The check first proves the supplied six tests fail, then requires a completed run,
one approved slice, planning/description artifacts, every pipeline outcome, a merged
branch, and a clean repository. Only `summary.mjs` may change. The original tests must
remain byte-for-byte identical and pass independently inside a fresh read-only,
network-disabled container after the merge. Agent wording, timings, and token counts
are not fixed. Each CLI invocation has a 15-minute timeout; Vitest limits the full test
to 32 minutes, with no automatic retries. Cleanup cancels pending commands. Failed repositories are
retained at the printed temporary path; successful ones are removed.
