# Agentic SDLC Orchestrator — Design

Date: 2026-09-25

## Purpose

A TypeScript CLI that automates a software development pipeline — turning a
request (a markdown file today, a GitHub issue later) into reviewed,
merge-ready commits — by orchestrating pluggable agentic coding CLIs (Claude
Code, opencode, etc.) through a fixed sequence of stages: context building,
feature planning, PR-slice planning, implementation, review, and merge/PR
creation. Usable as discrete commands for manual, step-by-step control, or as
a single `autopilot` run.

The long-term motivation is a "software factory": an eventual mode that
watches GitHub issues and runs this pipeline autonomously, at scale, across
many issues concurrently. This design does not build that mode, but every
architectural choice below has been checked against it (see
[Extensibility / Roadmap](#extensibility--roadmap)).

## Goals

- Abstract, provider-agnostic pipeline: swap the LLM/agent backend per step
  via configuration, no code changes.
- Usable both as individual CLI commands and as a full autonomous run.
- Safe by default: never touches shared remote state (GitHub, `origin`)
  without being told to; local `git` merges are opt-in, not automatic.
- Resumable across crashes and across machines.
- Small enough in scope to actually ship a v1.

## Non-goals (v1)

- No dependency graph / parallel slice execution. Slices are implemented
  strictly one at a time, in planner-assigned order. (Parked — see Roadmap.)
- No GitHub integration. No `gh` dependency anywhere in v1. `gh-issue` input
  source and `gh` PR/merge strategies are stubs only.
- No sandboxing/containerization of the agentic CLI process beyond the
  isolation `git worktree` already provides.
- No fleet-level orchestration (running many runs concurrently, a
  watch/trigger loop, cross-run scheduling).
- No attempt at exactly-once / fully idempotent step re-execution after a
  crash (see [Error Handling](#error-handling)).

## Architecture

Five layers:

1. **CLI layer** — parses commands (`prepare`, `implement`, `review`,
   `resolve-conflicts`, `merge`, `create-pr`, `status`, `resume`,
   `autopilot`) and calls into the reconciler with a filter describing what
   this invocation is allowed to do.
2. **Reconciler (orchestrator core)** — the single mechanism every command
   shares: load state → preflight conflict-check the current slice against
   `main` → compute the next actionable step for that slice given its status
   → execute it via the appropriate strategy → persist state → return.
   `autopilot`/`resume` loop this until the run completes or hits a blocking
   condition; single-step commands run it once, restricted to one step type.
   This is a deliberate application of the reconciliation-loop / controller
   pattern (declared vs. actual state, converge via repeated correction) —
   the same mechanism serves normal execution, manual step-by-step use, and
   crash recovery, so there is no separate "resume logic" to keep in sync.
3. **Strategies** — pluggable, config-selected implementations behind fixed
   interfaces (see [Strategies](#strategies) below).
4. **State store** — reads/writes run state to a dedicated git ref
   (`refs/jig/runs/<run-id>`), never the code branch, with a gitignored
   `.jig/` local checkout of that ref as a fast-read cache.
5. **Git utility layer** — branch/worktree creation, dry-run conflict check,
   commit, merge, push.

## Components

```
src/
  cli/            command definitions, argument parsing -> calls orchestrator
  orchestrator/   reconciler core, per-step-type handlers (context, plan,
                  slice-plan, implement, review, verify, resolveConflicts,
                  merge, prCreate)
  strategies/
    input-source/ markdown-file.ts, gh-issue.ts (stub), index.ts (registry)
    provider/     agentic-cli.ts (generic subprocess wrapper), index.ts
    merge/        manual.ts, auto.ts
    pr/           local.ts, gh.ts (stub)
  state/          read/write run state to git ref + local cache, schema/types
  git/            branch, worktree, conflict-check, merge, commit helpers
  config/         loads jig.config.{ts,json}
```

## Strategies

- **`InputSource`**: `markdown-file` (v1) | `gh-issue` (stub) — produces the
  raw request text/context that seeds `prepare`.
- **`AgentProvider`**: wraps an agentic CLI (`claude`, `opencode`, ...) as a
  subprocess, run headless/non-interactive in the slice's worktree with a
  constructed prompt. Used for every step needing a model: classification,
  feature planning, slice planning, implementation, review, conflict
  resolution. Config can assign a different provider/model per step. This
  mirrors how the Claude Agent SDK itself integrates an agentic CLI
  (spawn + structured output, no TTY) — not a workaround, the intended shape.
- **`Merge`**: `manual` (default — orchestrator never runs `git merge`, only
  detects that `main` already contains a slice's commits) | `auto` (opt-in
  via `--auto-merge` — orchestrator merges after review+verify pass).
- **`PrCreate`**: `local` (v1 — writes a PR description file, touches
  nothing external) | `gh` (stub — future `gh pr create` integration).

## State & Data Model

Local cache at `.jig/<run-id>/`, source of truth on
`refs/jig/runs/<run-id>`:

```
context.json     { rawRequest, classification, repoContext: {...}, createdAt }
plan.json        { summary, approach, affectedAreas: [...] }
slices.json      [{ id, title, description, order, status,
                    branch, reviewCycles, mergeAttempts }]
run-state.json   { runId, currentSliceId, phase, createdAt, updatedAt,
                   config: { providerOverrides, mergeMode, ... } }
logs/            <sliceId>-<step>-<n>.log   (raw provider transcripts)
```

Slice status machine:

```
pending -> implementing -> in_review -> (back to pending, if changes
requested by review OR verify, capped) -> ready_to_merge -> merged
```

Side-states reachable from most of the above: `conflict`, `stuck`.

## Data Flow

**`jig prepare`:**

1. `InputSource` resolves the raw request.
2. Context step (`AgentProvider`) reads the request + scans the repo ->
   `context.json`.
3. Feature-plan step (`AgentProvider`, fed `context.json`) -> `plan.json`.
4. Slice-plan step (`AgentProvider`, fed `plan.json`) -> `slices.json`, an
   **ordered list** (no dependency graph in v1).
5. A dedicated worktree is created off current `main`; the first slice's
   branch is created; state is committed to `refs/jig/runs/<run-id>`.

**Reconciler pass** (shared by `implement`/`review`/`autopilot`/`resume`):

1. Load state from the local cache, refreshed from the git ref if it moved
   since last read (covers resuming from a different machine/checkout).
2. Preflight: dry-run check whether the current slice's branch still applies
   cleanly onto current `main`. If not -> `conflict`; stop, or auto-invoke
   `resolveConflicts` (capped) under `--auto-merge`.
3. Dispatch on slice status:
   - `pending` -> implement step in the slice's worktree -> commit ->
     `in_review`.
   - `in_review` -> run AI review **and** the configured verify command
     (tests/build/lint) as two independent checks. Both must pass to
     proceed. Either failing -> "changes requested": increment
     `reviewCycles`; under cap, back to `pending` with feedback appended to
     the prompt; at cap, `stuck`.
   - `ready_to_merge` -> under `mergeMode: auto`, re-check conflicts then
     merge -> `merged`, advance to next slice, loop. Under `mergeMode:
manual`, stop here — a legitimate exit, not an error.
   - `merged` (detected by checking `main` directly, not trusted from
     state) -> advance to next slice automatically, even under `manual`
     mode — this is what lets `resume` pick back up after a manual merge.
4. Single-step commands run steps 1-3 once and exit regardless of outcome;
   `autopilot`/`resume` loop 2-3 until `slices.json` is fully `merged` or a
   stop condition (`conflict`, `stuck`, manual-mode `ready_to_merge`) halts.

## CLI Command Reference (v1)

```
jig prepare   --input <file>              start a run: context -> plan -> slices
jig implement [--slice <id>]              run implement once on current/given slice
jig review    [--slice <id>]              run AI review + verification once
jig resolve-conflicts [--slice <id>]      manually resolve a conflicted slice
jig merge     [--slice <id>]              manual convenience: merge an approved slice
jig create-pr [--slice <id>]              local: write PR description; future: gh pr create
jig status    [--run <id>]                show current run state
jig resume    [--run <id>]                re-enter the reconciler until blocked/done
jig autopilot --input <file>              prepare, then loop the reconciler to completion
```

## Config

`jig.config.{ts,json}`: per-step provider/model overrides, `mergeMode:
manual|auto`, `reviewCycleCap` (default 3), `conflictResolveCap`,
`verifyCommand`, `inputSource`.

`verifyCommand` is optional. If unset, the verify check is skipped and
`ready_to_merge` depends on the AI review verdict alone — the project is
assumed to have no scriptable check available yet, not that verification
was forgotten.

## Error Handling

- Provider process failure (non-zero exit/crash) -> step marked failed, run
  halts there, surfaced via `status`, re-runnable with the same command.
- Review or verify requests changes -> loop back to implement (feedback
  appended to prompt), capped (default 3); cap exceeded -> `stuck`, halts
  for human intervention.
- Merge conflict (preflight or at merge time) -> `conflict`; manual
  `resolve-conflicts` by default, auto-invoked with its own cap under
  `--auto-merge`.
- Crash mid-step -> **accepted v1 limitation**: resume reconciles against
  last-persisted state and re-runs the interrupted step from scratch. This
  is explicitly not guaranteed idempotent — a re-run implement pass may
  differ from the first attempt. No prior art in this space claims clean
  re-run safety either; v1 does not attempt to solve it.
- External/untrusted input (future `gh-issue` source) -> handled per
  [Security Considerations](#security-considerations).

## Security Considerations

Even though v1 ships only the `markdown-file` input source, the
`InputSource` -> `AgentProvider` seam is being designed now, so the
constraint is stated now:

- Content originating outside the operator's direct control (a GitHub issue
  body/comments, once `gh-issue` ships) must be treated as **untrusted
  data** interpolated into a prompt, never as instructions. This is not a
  hypothetical: a single malicious issue/PR title has been used to hijack
  Claude Code's own security-review agent, Gemini CLI Action, and GitHub
  Copilot's coding agent simultaneously via prompt injection (CVSS 9.4 in
  one documented case), exfiltrating secrets through the agent's own
  execution privileges.
- The `AgentProvider` strategy is responsible for clearly delimiting
  untrusted input in constructed prompts.
- Runs whose input originates externally should not give the agentic CLI
  process broad access to secrets/credentials by default; this constraint
  should be enforced at the point the `gh-issue` strategy is built, not
  left implicit.

## Code Quality Standards (Acceptance Criteria)

These apply to every module in the implementation and are acceptance
criteria, not stylistic preferences — a PR that doesn't meet them isn't
done:

- Clean, readable code; no incidental complexity left in for convenience.
- Strict separation of concerns: each module, class, and function owns one
  responsibility. A module's purpose should be statable in one sentence;
  if it needs "and," it's doing too much.
- No bloated files or function scopes. When a file or function is taking on
  more than one responsibility, split it rather than letting it grow.
- Every name must be instantly understandable on its own — no abbreviations,
  no generic dumping-ground names (`utils`, `helpers`, `manager`, `data`)
  unless the name is genuinely and narrowly accurate; a reader should never
  have to open a name to find out what it means.
- Declaration order follows usage order within a file: the higher-level
  entry point/usage site comes first, and the things it calls are declared
  after it, in the order they're first used — not alphabetical, not
  grouped by kind. A reader should be able to read a file top-to-bottom the
  way they'd read a newspaper: the important thing first, detail after.

## Tooling & Testing Strategy

- **Linting/formatting:** ESLint + Prettier, configured and enforced (lint
  clean is part of the acceptance bar, not advisory).
- **Test runner:** Vitest.
- **Mutation testing:** StrykerJS, configured against the Vitest suite, to
  validate that the test suite actually catches regressions rather than
  just executing code.
- **Secret scanning:** secretlint, run as a check so no credentials/API
  keys land in the repo (relevant given `AgentProvider` runs handle
  provider credentials).
- Reconciler core tested as a pure function (state + repo status -> next
  action) with an injected fake `AgentProvider` (canned responses) — no
  real subprocess spawning, deterministic, covers retry-cap/conflict/stuck
  transitions at no cost.
- Strategy implementations (`markdown-file` input, `git` conflict-check /
  merge helpers) get direct unit tests against a real temp git repo
  fixture.
- One end-to-end smoke test using a real agentic CLI, run manually/opt-in,
  not part of normal CI, given cost and non-determinism.

## Extensibility / Roadmap

Explicitly deferred, not designed in detail here, but the seams below are
where each lands without requiring changes to the reconciler core:

- **Dependency-graph / parallel slice execution.** `slices.json` gains a
  `dependsOn` field; the reconciler's "compute next actionable step" logic
  extends from "the one current slice" to "all currently-unblocked
  slices," dispatched into separate worktrees. Parking this was a
  deliberate v1 scope decision, not an architectural gap — the sequential
  version's reconciler contract doesn't need to change shape to grow into
  this.
- **`gh-issue` input source and `gh` merge/PR strategies.** These are the
  literal stub seams already named in [Strategies](#strategies).
- **Software factory (issue-driven, autonomous, at scale).** Cross-run
  concurrency is close to free in this design: each run is namespaced by
  `run-id` (its own git ref, branch(es), worktree), and the only shared
  mutable state is `main`, whose contention is already handled generically
  by the preflight conflict-check + merge strategy regardless of which run
  a colliding change came from. What's genuinely new and not yet designed:
  a trigger/watch loop (poll or webhook GitHub issues, spin up a run per
  issue), fleet-level status (enumerate `refs/jig/runs/*`), and a
  concurrency/cost throttle across concurrent runs.
- **Mirroring run state onto the GitHub issue via labels**, once
  `gh-issue` exists — cheap external visibility without inspecting
  internals; the pattern used by comparable prior-art projects
  (`falkobuttler/software-factory`).
- **Container-per-worktree isolation**, once parallel execution returns —
  worktrees isolate files only, not ports/databases/external accounts;
  field consensus treats this as necessary beyond roughly 4 concurrent
  agents.

## Prior Art / Validation

Researched against the current state of the art before finalizing this
design:

- `coleam00/ai-software-factory` and `falkobuttler/software-factory` are
  directly comparable issue-in/PR-out pipelines; both independently
  converged on manual-merge-first and a ~3-cycle review cap, matching this
  design's defaults.
- The reconciliation-loop/controller pattern is a recognized approach to
  "declared vs. actual state, converge via correction," not a
  Kubernetes-specific idiom.
- LLM-as-judge review is documented as gameable (self-enhancement/verbosity
  bias, reward hacking) — motivating the separate deterministic verify gate
  in this design rather than trusting the AI reviewer's verdict alone.
- Git-worktree-per-unit-of-work is the field-standard isolation pattern for
  this class of tool.
