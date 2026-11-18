# Run artifacts, CI, and observability

[Documentation](README.md) · [Project home](../README.md)

Use this guide to inspect a run's output, automate outcome handling, or resume work
on another machine. For container behavior, see [sandbox boundaries](sandbox.md);
for agent access, see [authentication](authentication.md).

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

### Run diagnostics

The saved run keeps what an operator needs to understand unfinished work, whether or
not it is ever published. Integrations read it through one projection
(`runDiagnostics` in `src/domain/diagnostics.ts`) rather than the raw state:

- **Unresolved reviews.** A slice whose review requested changes keeps that feedback
  as `rejectedReview` through the hook rejections, empty attempts and verification
  failures that follow, until a later review approves the slice. Earlier rounds stay
  in `feedbackHistory` but are not part of the projection.
- **Outstanding gaps.** The gaps of the latest final check, while it reports the
  request unfulfilled. A later fulfilled check leaves none.
- **Last verification failure.** The most recent failed verify command, from a slice
  (`failedVerification`) or the whole-run final check (`failedFinalVerification`),
  with its command, round or slice, and the last 3000 characters of its output kept
  verbatim, so file and line references survive. It stays after a later verification
  passes; `passedSince` (projected as `current: false`) marks it as history rather
  than a current problem.

Each recorded failure takes the next value of the run's `diagnosticSequence` as its
`at`, so the latest is known even during a final-check repair, when a slice failure
and a final-check failure coexist.

Runs saved before diagnostics were kept load without error: their failures carry
`at: 0`, earlier than any ordered one, and their output is
`{ "captured": false }` — unavailable, never an empty string. A final check saved
with a failed verification but no `failedFinalVerification` is projected the same
way, and a later check that passes keeps it as `failedFinalVerification` with its
command and round, `at: 0`, unavailable output and `passedSince: true`, so the
historical failure outlives the check that replaced it.

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

State is saved to every configured store. `run` and `status` read the freshest copy
(the one saved most often). `status` never moves a local branch or ref; `run` brings
a stale run branch up to date with `origin`. Other files in `.jig/<id>/state/` record
this machine's invocations and are not pushed.

Use the same config and preset when resuming. See [run commands](commands.md#start-inspect-and-resume).

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

Use `jig github implement --issue <number>` on the default branch. Re-run the same
command after an interrupted job. The accepted request and publication receipts live
at `refs/jig/_orchestration` in `orchestration.json`; run state remains at
`refs/jig/<runId>`. Preserve both when moving a repository or cleaning remote refs.
Updates use leases and retry competing writes rather than overwriting another job.
A per-run lock protects local execution, and publication is serialized per issue: a job
takes a 15-minute ownership lease in the orchestration state, renews it before each push,
comment or PR it makes, releases it however publication ends (a crash of jig itself
included), and a second job fails with `PublicationInProgress` until then. A crashed
job's lease lapses on its own; a job that finds its lapsed lease taken over stops with
`PublicationInProgress` before its next effect. A PR created before a crash is recovered
by its head. Every comment carries a hidden `<!-- jig:… -->` marker and is posted in a
single request, never retried blindly; when a comment was sent but its response or
receipt was lost, the next attempt finds it by marker instead of posting it again.

Review and merge completed PRs yourself. Completed runs without changes and halted,
stuck or blocked runs post an issue comment with their status and reason, without
opening a PR. Comments are recorded per run, outcome and code checkpoint; a receipt
for one checkpoint does not suppress a comment for another. Completed PRs do not add
a separate issue comment.

### Workflow refusals

jig never pushes a run whose changes touch `.github/workflows/`, because a pushed
workflow could run before anyone reviewed it. The check compares the exact code
checkpoint with its merge base on the default branch, with rename detection off, so
additions, edits, deletions, type changes and renames into or out of the directory all
count; workflows changed on the default branch since the run started do not. The
refusal, with every offending path, is saved in `orchestration.json` before the issue
comment is posted, and the comment has its own receipt. Re-running the command reports
the same refusal without commenting again. To proceed, make the workflow change
yourself and open a new issue for the rest.

### Deferred code publication

Issue runs save state to `refs/jig/<runId>` without pushing the run branch, so
unapproved code never reaches `origin`. The state commit does not reference the code,
and each save records the branch's commit as `codeRevision`, along with the
`startingCommit` the run began from. Only the publication step pushes the branch, and
only the inspected commit, leased against what `origin` held. Inspection fails closed:
if the default branch cannot be read, the histories share nothing, or the local run
branch no longer points at the saved checkpoint, nothing is pushed.

Resume an interrupted issue run from the clone that ran it: loading the run restores
its branch from objects this clone kept, or from the run branch already published on
`origin`. A clone with neither fails with `RunCodeUnavailable` instead of resuming from
code the state does not describe. Copies of the state saved at the same revision must
agree on the publication policy, starting commit and checkpoint; otherwise loading or
inspecting the run fails with `RunStateConflict` rather than letting store order pick
the code. A local branch with commits past the checkpoint is
kept; one that diverged from it is refused. Runs saved before checkpoints existed defer
from then on, keep whatever they already pushed, and have no recorded starting commit,
so jig never guesses one.
