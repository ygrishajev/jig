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
npm link   # or: node dist/cli/main.js <command>
```

Requires Node >=20. The agentic CLI named by `providerCommand` (see
Configuration below) must be separately installed and on `PATH` — this
tool only spawns it as a subprocess, it doesn't bundle one.

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

## Configuration

Optional `sdlc.config.json` in the repo root:

```json
{
  "mergeMode": "manual",
  "reviewCycleCap": 3,
  "verifyCommand": "npm test",
  "providerCommand": "claude"
}
```

| Field                | Default           | Meaning                                                                                                                                                               |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeMode`          | `"manual"`        | `"manual"`: the tool never merges a slice into your base branch itself — only detects that you did. `"auto"`: the tool merges automatically once a slice is approved. |
| `reviewCycleCap`     | `3`               | How many implement→review round-trips a slice gets before it's marked `stuck` and needs human intervention.                                                           |
| `verifyCommand`      | _(none)_          | An optional shell command (e.g. `npm test`) that must also pass, alongside the AI reviewer's approval, before a slice is considered ready to merge.                   |
| `inputSource`        | `"markdown-file"` | Only one supported in v1.                                                                                                                                             |
| `providerCommand`    | `"claude"`        | The agentic CLI binary to spawn for every step that needs a model.                                                                                                    |
| `conflictResolveCap` | `3`               | Reserved for a future conflict-auto-resolution feature; not currently read by anything.                                                                               |

## Commands

| Command                         | What it does                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `sdlc prepare --input <file>`   | Reads the request, produces a plan and an ordered list of slices.                                               |
| `sdlc implement --run <id>`     | Runs the implement step for the run's current slice.                                                            |
| `sdlc review --run <id>`        | Runs the review (+ verify command) step for the current slice.                                                  |
| `sdlc merge --run <id>`         | Manually merges an approved slice now, regardless of `mergeMode`.                                               |
| `sdlc create-pr --run <id>`     | Writes a local PR description for the current slice (no `gh` integration in v1).                                |
| `sdlc status --run <id>`        | Shows the run's slices and their status.                                                                        |
| `sdlc autopilot --input <file>` | Runs `prepare`, then loops the reconciler until the run completes or something needs your attention.            |
| `sdlc resume --run <id>`        | Re-enters the reconciler loop for an existing run (e.g. after a manual merge, or after fixing a `stuck` slice). |

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
