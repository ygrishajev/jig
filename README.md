# sdlc

An agentic SDLC pipeline orchestrator. It turns a markdown request into
reviewed, merge-ready commits by driving an agentic coding CLI (e.g.
[Claude Code](https://claude.com/claude-code)) through a fixed pipeline:
plan the feature, slice it into small reviewable units, then for each
slice — implement, review, merge, repeat.

See the [design spec](docs/superpowers/specs/2026-09-25-agentic-sdlc-orchestrator-design.md)
and [implementation plan](docs/superpowers/plans/2026-09-25-agentic-sdlc-orchestrator.md)
for the full architecture and its documented v1 scope cuts. See the
[manual end-to-end verification doc](docs/superpowers/plans/2026-09-25-agentic-sdlc-orchestrator-e2e-verification.md)
for a walkthrough using a real agentic CLI.

## Install

```bash
npm install
npm run build
npm run docker:build   # builds the agent sandbox image (see below)
npm link   # or: node dist/cli/main.js <command>
```

Requires Node >=20 and Docker running locally. Every agent invocation runs
inside a throwaway Docker container, never directly on your machine — see
[Agent sandbox & credentials](#agent-sandbox--credentials).

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

```bash
cd path/to/your/project        # any git repo — sdlc works IN a target repo,
                                # not on itself
echo "Add a health check endpoint at GET /health" > request.md
sdlc autopilot --input request.md
```

`sdlc` creates `.sdlc/` in the target repo to hold run state and a
dedicated worktree for implementing slices — it self-gitignores that
directory on first use, so nothing here needs to touch your project's own
`.gitignore`.

## Agent sandbox & credentials

Every step that calls an agent runs `--dangerously-skip-permissions`
(claude) / `--auto` (opencode) — full unattended file-write and bash
access, with no human approval gate. That's inherent to what an unattended
pipeline needs to do, so it's never run on the bare host: it only ever
runs inside the Docker image built by `npm run docker:build`
(`docker/agent-sandbox/Dockerfile`), with just the current step's working
directory bind-mounted in.

Set `providerCommand` in `sdlc.config.json` to pick which agent runs (see
Configuration below). Set `implementProviderCommand` too if you want the
implement step to use a _different_ agent than planning (`prepare`'s
context/plan/slice-plan steps) and review — e.g. claude for
planning/review, opencode for implementing. When both are set, you need
each provider's credentials set up on the host. Each provider has its own
one-time credential setup:

- **`claude`** (default) — run `claude setup-token` on your host once (an
  interactive, account-level action producing a long-lived token), then
  `export CLAUDE_CODE_OAUTH_TOKEN="<the token>"` in your shell before
  running `sdlc`. An `ANTHROPIC_API_KEY` env var works too, if you use one.
- **`opencode`** — run `opencode auth login` on your host once; its
  credentials file (`~/.local/share/opencode/auth.json`) is mounted
  read-only into the container automatically, no env var needed. Also set
  `opencodeModel` (`"provider/model"`, e.g. what `opencode models` lists) —
  a fresh sandbox container has no stored model preference, so without this
  opencode falls back to its own default, which may not support tool use
  (bash, file writes) on your OpenRouter account.

`sdlc` fails fast with a clear message if the selected provider's
credentials aren't available — it won't silently try to run a container
that can't authenticate.

## Configuration

Optional `sdlc.config.json` in the repo root:

```json
{
  "mergeMode": "manual",
  "reviewCycleCap": 3,
  "verifyCommand": "npm test",
  "providerCommand": "claude",
  "implementProviderCommand": "opencode",
  "opencodeModel": "openrouter/~z-ai/glm-flash-latest"
}
```

| Field                      | Default           | Meaning                                                                                                                                                                            |
| -------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeMode`                | `"manual"`        | `"manual"`: the tool never merges the run's branch into your base branch itself — only detects that you did. `"auto"`: the tool merges automatically once every slice is approved. |
| `reviewCycleCap`           | `3`               | How many implement→review round-trips a slice gets before it's marked `stuck` and needs human intervention.                                                                        |
| `verifyCommand`            | _(none)_          | An optional shell command (e.g. `npm test`) that must also pass, alongside the AI reviewer's approval, before a slice is considered ready to merge.                                |
| `inputSource`              | `"markdown-file"` | Only one supported in v1.                                                                                                                                                          |
| `providerCommand`          | `"claude"`        | Which agent runs planning (`prepare`) and review: `"claude"` or `"opencode"` — see [Agent sandbox & credentials](#agent-sandbox--credentials).                                     |
| `implementProviderCommand` | _(unset)_         | Overrides `providerCommand` for the implement step only. Falls back to `providerCommand` when unset.                                                                               |
| `opencodeModel`            | _(unset)_         | `"provider/model"` passed to opencode via `-m`. See [Agent sandbox & credentials](#agent-sandbox--credentials) for why this matters in the sandbox.                                |
| `conflictResolveCap`       | `3`               | Reserved for a future conflict-auto-resolution feature; not currently read by anything.                                                                                            |

## Commands

| Command                         | What it does                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sdlc prepare --input <file>`   | Reads the request, produces a plan and an ordered list of slices.                                                                    |
| `sdlc implement --run <id>`     | Runs the implement step for the run's current slice.                                                                                 |
| `sdlc review --run <id>`        | Runs the review (+ verify command) step for the current slice.                                                                       |
| `sdlc merge --run <id>`         | Manually merges the run's branch (every slice's commits, as one unit) now, once every slice is approved — regardless of `mergeMode`. |
| `sdlc create-pr --run <id>`     | Writes a local PR description for the whole run — every slice ships as one PR (no `gh` integration in v1).                           |
| `sdlc status --run <id>`        | Shows the run's slices and their status.                                                                                             |
| `sdlc autopilot --input <file>` | Runs `prepare`, then loops the reconciler until the run completes or something needs your attention.                                 |
| `sdlc resume --run <id>`        | Re-enters the reconciler loop for an existing run (e.g. after a manual merge, or after fixing a `stuck` slice).                      |

`implement` and `review` are aliases of the same underlying reconciler
step — each does whatever the current slice's status actually calls for.

## Development

```bash
npm test              # fast suite
npm run lint
npm run format:check
npm run test:mutation # StrykerJS, slow (~30 min)
npm run secretlint
```
