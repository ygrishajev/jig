# Commands and run lifecycle

[Documentation](README.md) · [Project home](../README.md)

| Command                                              | Purpose                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `jig init [--no-agent]`                              | Create and check sandbox and configuration files.               |
| `jig build [--pull-agents]`                          | Prepare the sandbox image.                                      |
| `jig run [request.md \| -] [--id <id>] [--no-merge]` | Start or resume a run.                                          |
| `jig status <id>`                                    | Show the saved phase, branch, documents, feedback, and metrics. |
| `jig github implement --issue <number>`              | Implement an issue and publish the outcome on GitHub.           |
| `jig presets`                                        | List available presets and their sources.                       |

| Option                  | Commands                                             | Behavior                                                                             |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `--config <path>`       | `init`, `build`, `run`, `status`, `github implement` | Select a [configuration file](configuration.md).                                     |
| `--preset [name]`       | `build`, `run`, `github implement`                   | Apply a named [preset](presets.md). Omit its name to open the interactive picker.    |
| `--log-format <format>` | `init`, `build`, `run`, `github implement`           | Accepts `pretty` or `json`. Defaults to `pretty` in a terminal and `json` otherwise. |

Use `jig --version` to print the installed version and `jig <command> --help` for command help.

## Initialize and build

`jig init` writes `.sandcastle/Dockerfile`, `.sandcastle/.gitignore`, and a starter
`jig.config.json`. In a terminal it asks for missing agents, models, and credentials.
jig can propose and check the toolchain, setup command, and verification command in Docker.
Review and commit the generated files before starting a run.

With `--no-agent`, jig writes missing starter files and checks configured commands without
asking an agent to propose them. Set all four agent roles yourself; without a
`verifyCommand`, it writes the files but cannot report a verified setup.

`jig build` builds when the Dockerfile or agent layer changes. `jig run` also builds
as needed. Use `jig build --pull-agents` to refresh unpinned agent CLIs even when
automatic updates are off. Both commands require all four agent roles, either in the
config or a preset.

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
to read when standard input is a terminal. Resume a piped run with `--id` alone,
or pipe the same request again with that id.
Ids may contain lowercase letters, digits, and hyphens.
Use the same `--config` and `--preset` when resuming.

`--no-merge` plans, implements, reviews and describes the run, then stops without
merging. The run ends `completed` and its branch `jig/run/<id>` is left for you to
review and merge. The choice is saved with the run, so a resumed run keeps it and the
flag is ignored on resume. `mergeMode` does not apply to these runs.

Only one process can run a given id at a time. With `designGate: "checkpoint"`, read
the design and plan when the run pauses, then resume with `jig run --id <id>`.

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
and comment on issues and pull requests. `GITHUB_REPOSITORY=owner/repo` overrides the identity inferred
from an HTTPS or SSH GitHub origin. Configure Git push authentication separately.

The first invocation uses the issue title and body as the request. Rerun the same command
to resume that request and reuse its open pull request. See [resuming issue runs](operations.md#github-issue-implementation)
for repository requirements after an interruption.

- A completed run with changes opens a ready PR. Review and merge it on GitHub.
- A stuck run with commits opens a draft PR with a conversation comment containing the
  findings, including any outstanding verification failure.
- A completed run without changes, a stuck run without commits, or a halted or blocked run
  posts its outcome on the issue.
- Changes under `.github/workflows/` prevent publication of the run branch. The issue
  comment lists the affected paths.

The command prints the URL of the PR or issue comment. For draft PRs it also prints the
findings comment URL.
