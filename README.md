# sdlc

An agentic SDLC pipeline orchestrator. It turns a markdown request into
reviewed, merge-ready commits by driving an agentic coding CLI (e.g.
[Claude Code](https://claude.com/claude-code)) through a fixed pipeline:
plan the feature, slice it into small reviewable units, then for each
slice — implement, review, merge, repeat.

Agents run unattended inside a [sandcastle](https://github.com/mattpocock/sandcastle)
Docker sandbox, one per run. The current design is in
[the sandcastle migration spec](docs/superpowers/specs/2026-10-29-sandcastle-migration-design.md);
the whole run is defined in one place, [`src/flow/run-flow.ts`](src/flow/run-flow.ts).

## Install

```bash
npm install
npm run build
npm link   # or: node dist/cli/main.js <command>
```

Requires Node >=20 and Docker running locally.

### Installing from another repo

`sdlc` publishes as `@ygrishajev/sdlc` to GitHub Packages (private npm
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
npm install @ygrishajev/sdlc
```

In CI, set `NODE_AUTH_TOKEN` to that token before `npm install` (e.g. a
repo secret), same as `registry-url` in `actions/setup-node`.

## Quickstart

In the repository you want sdlc to work on:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=...   # from `claude setup-token` (or ANTHROPIC_API_KEY)
sdlc init                            # sandbox Dockerfile + config, checked inside the sandbox
git add .sandcastle sdlc.config.json && git commit -m "set up sdlc"
sdlc run request.md                  # plan, implement, review, verify, describe, merge
```

## Commands

| Command                             | What it does                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdlc init [--no-agent]`            | Writes `.sandcastle/Dockerfile`, its `.gitignore` and a starter `sdlc.config.json`. With an agent (default), the planner fills in the toolchain and `setupCommand`/`verifyCommand`, and they are accepted only once both pass inside the sandbox (up to 3 attempts). |
| `sdlc build [--pull-agents]`        | Builds the sandbox image if the Dockerfile or the agents changed. `run` does this too.                                                                                                                                                                               |
| `sdlc run [request.md] [--id <id>]` | Starts a run from a request file, or resumes one by id. With both, it resumes only if the file is the request the run started with.                                                                                                                                  |
| `sdlc status <id>`                  | Where a run is, its slices and feedback, and its cost so far.                                                                                                                                                                                                        |

`run` stops (exit 0) when the work is merged, waits for a manual merge, pauses at the design
checkpoint, blocks, or gets stuck; `result.json` says which. Resume with `sdlc run --id <id>`.

## The sandbox

- **One sandbox per run.** Every agent call and the verify command run in the same container,
  over a worktree sandcastle keeps for the run branch `sdlc/run/<id>`.
- **Image.** `.sandcastle/Dockerfile` is the repository's: base tools, then the project's
  toolchain between the marked lines. sdlc adds a layer with the agent CLIs the config uses, at
  exact versions, built per machine with your UID. Labels on the image decide what to rebuild.
- **Credentials** come from the environment and go into the container as env vars:
  claude needs `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; opencode needs its provider's
  key, e.g. `OPENROUTER_API_KEY` for an `openrouter/...` model.

## Configuration

`sdlc.config.json` in the repository root (strict: unknown keys are errors).

| Key                                               | Default                    |                                                                                                                                                                            |
| ------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planner`, `implementer`, `reviewer`, `describer` | `{ "provider": "claude" }` | Agent per step; `model` optional for claude (default `opus`), required for opencode (`provider/model`).                                                                    |
| `setupCommand` / `setupTimeoutSeconds`            | — / `900`                  | Runs once in the sandbox before any agent, e.g. `npm ci`.                                                                                                                  |
| `verifyCommand`                                   | —                          | Must pass in the sandbox before a reviewed slice is approved.                                                                                                              |
| `mergeMode`                                       | `"manual"`                 | `auto` merges the run branch at the end.                                                                                                                                   |
| `designGate`                                      | `"auto"`                   | `checkpoint` pauses after planning.                                                                                                                                        |
| `reviewCycleCap`                                  | `3`                        | Rejections before a slice is stuck.                                                                                                                                        |
| `commitSigning`                                   | `"repo"`                   | `skip` disables signing in the run's worktree.                                                                                                                             |
| `sandboxImage`                                    | —                          | Use this image as-is instead of building one.                                                                                                                              |
| `agents`                                          | `{}`                       | Pin agent CLI versions, e.g. `{ "claude": "2.1.312" }`.                                                                                                                    |
| `agentUpdates`                                    | `"auto"`                   | `warn` or `off`; how unpinned agents follow new releases.                                                                                                                  |
| `agentIdleTimeoutSeconds`                         | `600`                      | An agent silent this long is stopped.                                                                                                                                      |
| `runStores`                                       | `["local"]`                | Add `"git-remote"` to push state (hidden `refs/sdlc/<id>`) and the run branch to `origin`, so another machine can resume; or a path to a module exporting a store factory. |

## CI and observability

- `--log-format json` (default when not a TTY); every run also logs to `.sdlc/<id>/state/run.log`.
- `.sdlc/<id>/state/result.json`: `status`, `complete`, `blockedReason`, and `metrics`
  (cost, tokens, durations, review rounds). The same summary is the footer of
  `PR_DESCRIPTION.md`; `metrics.jsonl` has one line per step and agent call.
- `SDLC_IMAGE_CACHE=gha` builds through buildx with the GitHub Actions cache.
- `OTEL_EXPORTER_OTLP_ENDPOINT` exports the run as an OpenTelemetry trace and turns on
  Claude Code's own telemetry in the sandbox.

## Development

```bash
npm test              # fast suite
npm run lint
npm run format:check
npm run test:mutation # StrykerJS, slow (~30 min)
npm run secretlint
```
