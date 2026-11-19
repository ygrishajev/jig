# Run artifacts, CI, and observability

[Documentation](README.md) · [Project home](../README.md)

## Run artifacts

Local artifacts live in `.jig/<id>/state/`. jig writes `result.json` and the available
documents each time `jig run` reports an outcome. `jig status <id>` lists the documents
available on the current machine.

| File                | Contents                                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result.json`       | Outcome fields: `status` (`done`, `completed`, `halted`, `blocked`, `stuck`), `complete` (true for `done` and `completed`), `blockedReason`, and `metrics`. |
| `design.md`         | Current design, including any revisions requested during design review.                                                                                     |
| `plan.md`           | Current implementation plan.                                                                                                                                |
| `design-review.md`  | Review findings, evidence, uncertainty, planner responses, and unresolved decisions.                                                                        |
| `PR_DESCRIPTION.md` | Generated pull request description with a metrics summary.                                                                                                  |
| `run.log`           | Run log.                                                                                                                                                    |
| `metrics.jsonl`     | One record per step or agent call, including planning and design review.                                                                                    |

`design-review.md` preserves the documents as first reviewed and indicates how far
the review progressed. A pending review is never reported as approved. Unresolved
findings also appear in the saved run's `blockedReason`, which `jig status` can show
on a machine without the local report files.

## CI outcome handling

`jig run` exits 0 for every reported run outcome, including `blocked` and `stuck`.
Command errors exit nonzero. Automation must inspect `result.json` as well as the
exit code; see [outcomes and recovery](commands.md#outcomes-and-recovery) for the
meaning of each status. A manual-merge run normally stops with `halted`.
`done` and `completed` both write `complete: true`; check `status` when you must know
whether the branch was merged (`completed` means it was left unmerged).

Pass an explicit run id and preset name in CI, for example:

```bash
jig run request.md --id ci-example --preset claude-only --log-format json
```

Provision Docker and the [agent credentials](authentication.md) before invoking jig.
Use a new id for each new request; an existing id resumes its saved run.
Set `JIG_IMAGE_CACHE=gha` to use the GitHub Actions cache through buildx.

## Saved state and remote resume

`runStores` defaults to `["local"]`. Add `"git-remote"` to save state under
`refs/jig/<id>` and push the run branch to `origin`, allowing another machine to resume.

Use the same config and preset when resuming. `jig status` reads the saved state without
updating local branches.

### Custom stores

A `runStores` entry can also name a module path. The module default-exports a factory
with this interface:

```text
({ repoRoot }) => ({ load(runId), save(state), peek?(runId) })
```

`status` uses `peek`, falling back to `load` when it is absent. Returned state is
validated as a run. `load` and `peek` return a run object, or `null`/`undefined` when
absent; `save` receives the run object. Methods may be asynchronous. See the
[module store adapter](../src/app/run-stores.ts) for the module contract.

## Logs and tracing

`--log-format json` enables structured logs and is the default outside a terminal.
Each run also logs to `.jig/<id>/state/run.log`.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to export the
run as an OpenTelemetry trace and enable Claude Code's telemetry in the sandbox.
Every `OTEL_*` variable is forwarded to the container, including
`OTEL_EXPORTER_OTLP_HEADERS`. The endpoint must be reachable from inside the container;
`localhost` there refers to the container itself.

## GitHub issue implementation

After an interruption, rerun `jig github implement --issue <number>` from the original
clone. A different clone can resume if it has access to the saved run commit, for
example after the run branch has been published to `origin`. Issue runs save state to
the remote during execution and publish the run branch when opening a PR.

Keep `refs/jig/<id>` and `refs/jig/_orchestration` on the remote to preserve run state
and publication records. Repeating the same outcome reuses the existing PR or comment.
See [GitHub command outcomes](commands.md#implement-a-github-issue).
