Treat this request as self-contained — everything needed is below; don't assume access to any
other issue or request. It lands after three changes to the slice loop: slices record a passing
verify as `verification: { command }`, verify runs before review, and the reviewer is told about
changed tests and check config. Build on what `src/flow/run-flow.ts`, `src/steps/slice.ts` and
`src/steps/pull-request-description.ts` contain when you start.

## What

After all slices are done, jig checks the run as a whole: the project's checks pass on the final
code, and a reviewer confirms the combined change does what the original request asked. If the
check fails, jig makes one attempt to fix what it found before handing the run to a person. The
pull request says what the final check found.

## Why

Every slice is checked alone. Nothing confirms that the slices together deliver the request,
that no plan step was dropped, or that a later slice did not break an earlier one's behaviour in
a way only the combined code shows. A person merging the PR should not be the first to check this.

## Context — read this first

jig is a Node/TypeScript CLI. A run is a state machine, `runFlow` in `src/flow/run-flow.ts`:
`context → planning → designing → slicing → gate → slices → describing → merging → done`.
`slices` runs every slice's implement/verify/review loop and moves on with `allApproved` or
`sliceStuck`. `describing` writes the PR description (`src/steps/finishing.ts`), then goes to
`stuck` if any slice is stuck (`someSliceStuck`) or else to `merging`. Run state and its zod
schema are in `src/domain/run-state.ts`; outcomes in `src/domain/outcome.ts`, folded into state by
`src/domain/apply-outcome.ts`. Agents are called through `ports.agent.runForOutput({ role, prompt,
schema })` (zod-parsed reply) and commands through `ports.agent.exec(command)`. The original
request text is `state.request`; the plan is `state.docs.plan` (markdown with
`## Step N — <title>` headings). Specs sit beside the code. House rules are in `.claude/rules/` —
read them before writing code.

## Target behaviour

1. **New phase `finalCheck`** between `slices` and `describing`, entered on `allApproved` only (a
   run with a stuck slice skips it and goes to `describing` as today).
2. **The step** (`src/steps/final-check.ts`, prompt in `src/prompts/final-check.ts`):
   - runs `verifyCommand` once on the run branch's tip, if configured;
   - asks the `reviewer` role to review the whole range from the fork point
     (`ports.workspace.forkPoint()`) to `HEAD` against `state.request` and `state.docs.plan`, and
     reply `{ fulfilled: boolean, gaps: string }` — `gaps` names any request requirement or plan
     step not delivered;
   - returns an outcome that `applyOutcome` stores as `finalCheck: { verify: 'passed' | 'failed' |
'not-configured', fulfilled, gaps }` on run state (optional field; old saved runs must load).
3. **One fix-up round before giving up.** The first time the final check fails (verify failed, or
   `fulfilled: false`), jig appends one extra slice and goes back to `slices`:
   - id `final-fixes` (if a planned slice already uses that id, add a numeric suffix so ids stay
     unique), `order` one past the last slice, status `pending`;
   - its description is the failure itself: the end of the verify output (last ~3000 characters)
     and/or the reviewer's `gaps`, with the instruction to fix exactly that and nothing else;
   - its title is a neutral one-line commit header, at most 72 characters.
     That slice goes through the normal implement → verify → review loop and its `reviewCycleCap`.
     When it is approved, `finalCheck` runs again. The extra slice works with today's slice loop:
     `currentSlice` picks the first slice that is not approved, and `sliceStart` starts its range
     at the previous slice's commit.
4. **Then the result decides the ending.** Count the rounds on run state (e.g.
   `finalCheck.round`), so a resumed run never adds a second fix-up slice. If the final check
   fails again after the fix-up round, or the fix-up slice gets stuck, the run goes to
   `describing` and then ends `stuck` exactly like a stuck slice: no merge, even in
   `mergeMode: "auto"`. A passing final check goes to `describing` → `merging` as today.
5. **The PR says it.** `renderPullRequest` shows the final-check result next to jig's per-slice
   verification; gaps are listed under the deviations. The describer prompt receives it as fact.

## Don't undo these

- A run with a stuck slice is still described, so the reviewer's feedback reaches a person.
- `mergeRunBranch` refuses a branch whose tip is not the last approved commit — keep that guard;
  the final check makes no commits; the fix-up slice commits through the normal slice loop.
- Exactly one fix-up round. Never loop the final check without a limit.
- jig never `throw`s; agents run only inside the sandbox.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it.

## Done when

- [ ] `src/flow/run-flow.spec.ts` covers: all approved → finalCheck → describing → merging;
      first failure → a `final-fixes` slice → finalCheck again → passing → merging; second
      failure → describing → stuck; fix-up slice stuck → describing → stuck; stuck planned slice
      → describing without finalCheck
- [ ] a spec shows the fix-up slice's description carrying the verify output and the gaps, and
      a resumed run not adding a second fix-up slice
- [ ] a spec for the step covers verify passed / failed / not configured and the reviewer's
      verdict being stored
- [ ] a saved run state without `finalCheck` still parses
- [ ] `npm run validate -- --skip test:mutation` passes
