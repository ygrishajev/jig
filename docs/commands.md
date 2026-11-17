# Commands and run lifecycle

[Documentation](README.md) · [Project home](../README.md)

| Command                                              | Purpose                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `jig init [--no-agent]`                              | Create and check the sandbox Dockerfile and config.             |
| `jig build [--pull-agents]`                          | Build the image; optionally refresh unpinned agent CLIs.        |
| `jig run [request.md \| -] [--id <id>] [--no-merge]` | Start a run or resume a saved one.                              |
| `jig status <id>`                                    | Show the phase, branch, documents, slice feedback, and metrics. |
| `jig github implement --issue <number>`              | Implement an issue and publish a pull request.                  |
| `jig presets`                                        | List available presets, sources, and descriptions.              |

Use `jig <command> --help` for flags. `init`, `build`, `run`, and `status` accept
`--config <path>`. `build` and `run` accept `--preset [name]`. `init`, `build`, and
`run` accept `--log-format pretty|json`.

## Initialize and build

`jig init` writes `.sandcastle/Dockerfile`, `.sandcastle/.gitignore`, and a starter
`jig.config.json`. In a terminal it asks for missing agents, models, and credentials.
The planner proposes the toolchain, setup command, and verification command. jig checks
both commands in a sandbox and gives the planner up to three attempts to fix failures.
Review and commit the generated files before starting a run.

With `--no-agent`, jig writes missing starter files and checks configured commands without
asking an agent to propose them. Set all four agent roles yourself; without a
`verifyCommand`, it writes the files but cannot report a verified setup.

`jig build` builds when the Dockerfile or agent layer changes. `jig run` also builds
as needed. Both require all four agent roles, either in the config or a preset.

## Start, inspect, and resume

```bash
jig run request.md
jig run request.md --id add-search
jig status add-search
jig run --id add-search
gh issue view 7 --json title,body -q '"# \(.title)\n\n\(.body)"' | jig run - --id issue-7
```

Without `--id`, jig names a new run after the request's first `# heading`, or its file
name, plus a random suffix. With a request and an existing id, it resumes only if the
request matches the saved one. An id without a request must identify a saved run.
Pass `-` instead of a file to read the request from standard input. A piped request
without a `# heading` is named `stdin-<random>`. jig refuses empty input, and refuses
to read when standard input is a terminal. Resuming a piped run needs the same piped
text with the same `--id`.
Ids may contain lowercase letters, digits, and hyphens.
Use the same `--config` and `--preset` when resuming.

`--no-merge` plans, implements, reviews and describes the run, then stops without
merging. The run ends `completed` and its branch `jig/run/<id>` is left for you to
review and merge. The choice is saved with the run, so a resumed run keeps it and the
flag is ignored on resume. `mergeMode` does not apply to these runs.

One process can run a given id at a time. A second invocation fails immediately;
a lock left by a crashed process expires after 30 seconds.

## Pipeline

1. The planner reads the repository, plans the feature, and writes the design and plan.
2. The reviewer checks those documents before slicing. Findings get one planner revision
   and one re-review. Findings still unresolved block the run in either design gate mode.
   Evidence, uncertainty, and planner dispositions are saved in `design-review.md`.
3. The planner divides the plan into slices. jig checks that the slices cover its steps.
   With `designGate: "checkpoint"`, it pauses here. Read the documents, then resume.
4. For each slice, the implementer changes the code, the verification command runs,
   and the reviewer checks the changes. Rejections return to implementation.
   Changes to existing tests or validation settings are flagged for the reviewer.
   A single-slice run's review also judges the whole request against its plan; the
   verdict is recorded bound to the exact work, verification, sources and settings
   it saw, with the facts observed around both.
5. After all slices pass, jig decides whether the run can finish on that recorded
   review. It can when the run has one approved slice and no final check yet, the
   review found the request fulfilled with no gaps, a verify command is configured
   and passed on exactly the reviewed work, the request, plan and settings are
   unchanged, and the run branch and sandbox are both clean at that work. Such a run
   skips the final check: verification and review each ran once. Any other run gets
   the final check: jig runs verification again and asks the reviewer whether the
   whole request is fulfilled. A failure gets one repair slice through the same
   implementation, verification, and review loop, followed by a second final check.
6. jig writes `PR_DESCRIPTION.md`, then waits for a manual merge or merges automatically.
   It writes a description; it does not open a pull request. A reused review is
   reported with the reviewed range, commit and verification it rests on. Before
   describing, merging, and waiting for a merge, including on resume, jig checks the
   reused review still holds. If it does not, jig drops the reuse and its description
   and runs the ordinary final check, which still allows its one repair.
   Invalidation keeps the saved evidence, spends no repair round, and applies equally to a
   resumed run reloaded from saved state: a changed request, plan, settings, run range,
   commit or tree, or a dirty work tree, sends it to the final check. A run saved before
   evidence was recorded has none to reuse and always takes the final check.

`reviewCycleCap` limits reviewer rejections only (three by default).
Commit-hook failures and verification failures each have an independent cap of three
per slice, accumulated across attempts. These counters persist across resume; older snapshots start them at zero.
Empty implementation attempts and fixes limited to house rules each have a separate
cap of two. A stuck slice skips the final check. If the second final check fails,
the run is described and ends as stuck without merging.

## Outcomes and recovery

`jig run` exits 0 for every reported run outcome. Read
[`.jig/<id>/state/result.json`](operations.md#ci-outcome-handling) to distinguish them.
Command errors, such as invalid configuration, exit nonzero.

| Status      | Meaning                                                          | Next action                                                                          |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `done`      | The run branch is merged.                                        | Inspect the result. Resuming returns the saved result.                               |
| `completed` | The run finished without merging (`--no-merge`).                 | Review and merge `jig/run/<id>` yourself. Resuming returns the saved result.         |
| `halted`    | Paused at the checkpoint or waiting for a merge.                 | Read the docs or merge the branch, then resume.                                      |
| `blocked`   | A step could not continue, including unresolved design findings. | Inspect the reason and fix its cause before resuming.                                |
| `stuck`     | A slice hit a cap or the final check still failed after repair.  | Finish by hand on `jig/run/<id>`, or start a new run. Resuming does no further work. |

`halted` covers both the checkpoint pause and the manual-merge wait; the phase in
`result.json` and `jig status` (`paused` or `awaitingMerge`) tells them apart.

A design blocked after re-review has spent its automatic revision allowance. Resuming
alone does not grant another revision; use its findings to clarify a new request.
A resumed run detects plain, squash, and rebase merges, including merges on the base
branch's remote before you pull them locally. Automatic merging requires a clean
operator working tree; resolve conflicts or unrelated local changes before resuming.

## Implement a GitHub issue

```bash
jig github implement --issue 42
```

Run from the default branch of a repository with an `origin` you can push to.
Set `GITHUB_TOKEN` (or `GH_TOKEN`) with permission to read issues, open pull requests
and comment on issues. `GITHUB_REPOSITORY=owner/repo` overrides the identity inferred
from an HTTPS or SSH GitHub origin. Git push authentication is configured separately.
The command accepts `--config`, `--preset` and `--log-format` like `jig run`.

The first invocation saves the issue title and body as an immutable request. Repeating
the command resumes that run, even if the issue was edited. State is always saved to
`git-remote` as well as configured stores, so another clone can resume it.
The operator branch is never merged. A completed run opens a PR that closes the issue;
a completed run without changes posts one issue comment and opens no PR. Halted,
blocked and stuck runs comment with their status and reason, without opening a PR.
Existing open PRs are reused. Comment receipts are keyed by run, outcome and branch
revision, so repeating an outcome at the same revision does not comment again.
The command prints the PR URL (including whether it was reused) or comment URL and status.
