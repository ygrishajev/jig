Treat this request as self-contained — everything needed is below; don't assume access to any
other issue or request.

## What

Before any code is written, jig checks that the planned slices cover every step of the
implementation plan and refer only to steps that exist. A mismatch goes back to the planner to
fix; if it still does not match, the run stops with a clear message.

## Why

The plan is written by one agent call and broken into slices by another. Today jig only checks
that the reply has the right shape. A dropped plan step means a feature silently missing from the
pull request; a slice pointing at a step that doesn't exist means work nobody planned.

## Context — read this first

jig is a Node/TypeScript CLI. Planning steps are in `src/steps/planning.ts`, prompts in
`src/prompts/planning.ts`. `writeDesign` produces `state.docs.plan`: markdown whose steps are
headings `## Step N — <title>` (the design prompt asks for exactly that). `sliceThePlan` asks the
planner for slices and parses them with zod; the slice prompt requires every slice description to
start with `Implements plan step N`. The only content check today is `requireUniqueIds`, which
returns `Result.err(new AgentOutputInvalid(...))` on duplicate ids. Errors live in
`src/domain/errors.ts`. Specs sit beside the code. House rules are in `.claude/rules/` — read
`errors-as-values.md`, `callee-owns-its-rules.md`, `testing-conventions.md` first.

## Target behaviour

1. **Parse the plan's step numbers** from `## Step N` headings (tolerate `—`, `-` or `:` after the
   number). A plan with no such headings is itself `AgentOutputInvalid` with a message saying so.
2. **Check the slices** after `requireUniqueIds`:
   - every slice description starts with `Implements plan step N` (one or more numbers, e.g.
     `Implements plan steps 2 and 3` is fine — decide the accepted forms and spec them);
   - every N exists in the plan;
   - every plan step is claimed by at least one slice.
3. **One correction round.** On a mismatch, call the planner once more with the slice prompt plus
   a precise list of problems ("plan step 4 has no slice", "slice `add-cache` names step 7, which
   does not exist"). If the second answer still fails the check, return `AgentOutputInvalid` with
   that list — the run stops and the operator sees why.
4. Keep the check a small pure function with its own spec; the step only calls it.

## Don't undo these

Land this before the separate design-review change, which also touches planning files. That
change adds semantic review before slicing; this request independently checks step references
and coverage after slicing and must remain in place.

- There is no minimum slice count: one slice covering every step is valid.
- `designGate` stays `auto` by default — changing defaults is out of scope.
- jig never `throw`s; the check returns a `Result`.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it.

## Done when

- [ ] the check's spec covers: all covered; a missing step; an unknown step; a slice without the
      prefix; one slice covering all steps; a plan without step headings
- [ ] `src/steps/planning.spec.ts` covers the correction round succeeding and the second failure
      becoming `AgentOutputInvalid`
- [ ] `npm run validate -- --skip test:mutation` passes
