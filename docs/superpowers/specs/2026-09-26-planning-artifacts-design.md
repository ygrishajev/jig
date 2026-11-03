# Human-Readable Planning Artifacts

Date: 2026-09-26

## Problem

jig's planning phase produces machine state only (`plan.json` with `summary` /
`approach` / `affectedAreas`, `slices.json` with descriptions). When a run
reaches a merge-ready state or a PR, there is nothing a human can read to
understand the overall design, the plan, or which part of the plan a slice
implements — the reviewer must reverse-engineer intent from code and commit
messages.

## Goal

Planning produces two human-readable markdown artifacts that (a) drive slice
planning, (b) are visible at every review surface (status, PR description,
blocked-run output), and (c) never get committed to the target repository.

## Non-Goals

- No superpowers dependency: the design-process discipline (approaches,
  trade-offs, recorded decisions) is encoded in jig's own prompts. The
  skills' interactivity does not survive an unattended sandbox run.
- Planning docs are never committed into the target repo — no
  `planningDocs: 'commit'` mode. They live in run state only.
- No `gh` CLI integration yet. `create-pr` continues to write
  `PR_DESCRIPTION.md` into the state dir; a future gh layer reads that file.

## Artifacts

Two markdown files in `<stateDir>` (i.e. `.jig/<runId>/state/`):

- `design.md` — sections: Goal; Context; Chosen approach; Alternatives
  considered (each with why it was rejected); Assumptions; Non-goals;
  Affected areas.
- `plan.md` — the overall implementation plan as numbered steps
  (`## Step 1 — <title>` …), each step small enough to map onto one slice.

## Pipeline Changes (`prepare.ts`, `prompts.ts`)

1. Context step: unchanged.
2. Feature-plan step: unchanged (still produces the machine JSON).
3. **New design step** (after feature-plan, before slice-plan): the agent is
   instructed to write `design.md` and `plan.md` to explicit state-dir paths,
   then respond with structured JSON `{ "written": ["design.md", "plan.md"] }`
   as the ack. jig validates both files exist and are non-empty; missing or
   empty files fail the run with a clear error. The prompt encodes the
   self-direction rule: "you run unattended — when you would present options
   to a human, evaluate 2–3 approaches, pick the recommended one, and record
   the alternatives with rejection rationale in design.md."
4. Slice-plan step: prompt now embeds `plan.md` verbatim and requires every
   slice description to start with `Implements plan step N`. The existing
   standalone-deliverable guidance (10-minute skim bound, no
   prerequisite-only slices) stays.

## Design Gate (configurable)

- Config: `designGate: 'auto' | 'checkpoint'`, default `'auto'`.
- `checkpoint`: the `autopilot` command stops right after `prepareRun`
  succeeds, prints the design.md / plan.md paths plus the plan, and instructs
  `jig resume --run <id>`. Implementation never starts until resume.
  No new run-state field is needed: planning already happened exactly once,
  and `resume` only ever runs the reconciler.
- `auto`: unchanged behavior (plan, then implement immediately).

## Review Surfaces

- `jig status --run <id>`: prints design.md and plan.md paths when present.
- `jig create-pr --run <id>`: `PR_DESCRIPTION.md` becomes: run request
  title, the full `design.md`, the full `plan.md`, then a per-slice list
  (`<slice id> — Implements plan step N — <title>`), with the current
  slice's entry marked.
- Blocked-run output (autopilot/resume exit) already prints the worktree and
  commits; it additionally prints the design/plan paths.

## Testing

- `prepare`: the design step writes both files (FakeAgentProvider writes
  real files); missing or empty design.md/plan.md → clear error, run state
  not left half-planned; slice-plan prompt contains plan.md content.
- CLI: `designGate: 'checkpoint'` stops autopilot after planning; `resume`
  proceeds. `create-pr` description contains design and plan content and the
  step mapping. `status` prints doc paths.
- Full suite + typecheck + lint + prettier.

## Files Touched

- `src/orchestrator/prepare.ts` — design step, plan.md handoff
- `src/orchestrator/prompts.ts` — design-step prompt; slice-plan prompt input
- `src/config/load-config.ts` — `designGate`
- `src/cli/commands/autopilot.ts` — checkpoint stop; blocked output paths
- `src/cli/commands/create-pr.ts`, `src/strategies/pr/local.ts` — rich body
- `src/cli/commands/status.ts` — doc paths
- corresponding tests
