# Commands and run lifecycle

[Documentation](README.md) · [Project home](../README.md)

| Command                            | Purpose                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `jig init [--no-agent]`            | Create and check the sandbox Dockerfile and config.             |
| `jig build [--pull-agents]`        | Build the image; optionally refresh unpinned agent CLIs.        |
| `jig run [request.md] [--id <id>]` | Start a run or resume a saved one.                              |
| `jig status <id>`                  | Show the phase, branch, documents, slice feedback, and metrics. |
| `jig presets`                      | List available presets, sources, and descriptions.              |

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
```

Without `--id`, jig names a new run after the request's first `# heading`, or its file
name, plus a random suffix. With a request and an existing id, it resumes only if the
request matches the saved one. An id without a request must identify a saved run.
Ids may contain lowercase letters, digits, and hyphens.
Use the same `--config` and `--preset` when resuming.

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
   verdict is recorded bound to the exact work, sources and settings it saw. The
   final check still runs for every run.
5. After all slices pass, jig runs verification again and asks the reviewer whether
   the whole request is fulfilled. A failure gets one repair slice through the same
   implementation, verification, and review loop, followed by a second final check.
6. jig writes `PR_DESCRIPTION.md`, then waits for a manual merge or merges automatically.
   It writes a description; it does not open a pull request.

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

| Status    | Meaning                                                          | Next action                                                                          |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `done`    | The run branch is merged.                                        | Inspect the result. Resuming returns the saved result.                               |
| `halted`  | Paused at the checkpoint or waiting for a merge.                 | Read the docs or merge the branch, then resume.                                      |
| `blocked` | A step could not continue, including unresolved design findings. | Inspect the reason and fix its cause before resuming.                                |
| `stuck`   | A slice hit a cap or the final check still failed after repair.  | Finish by hand on `jig/run/<id>`, or start a new run. Resuming does no further work. |

A design blocked after re-review has spent its automatic revision allowance. Resuming
alone does not grant another revision; use its findings to clarify a new request.
A resumed run detects plain, squash, and rebase merges, including merges on the base
branch's remote before you pull them locally. Automatic merging requires a clean
operator working tree; resolve conflicts or unrelated local changes before resuming.
