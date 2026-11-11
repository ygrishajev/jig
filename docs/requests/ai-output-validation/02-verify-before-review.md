Treat this request as self-contained — everything needed is below; don't assume access to any
other issue or request. It builds on an earlier change that stores a passing verify result on
each slice as `verification: { command }`; if `sliceSchema` in `src/domain/slice.ts` has no
`verification` field yet, stop and say so in the PR — that change must land first.

## What

Each slice's code is checked by the project's own test and lint command before the reviewer agent
looks at it, and the reviewer is told the result. When the check fails, the implementer gets
enough of the failure to fix it.

## Why

Today the reviewer approves first and the checks run after. The reviewer judges blind, and a
review is spent on code that would have failed anyway. When the checks do fail, the implementer
sees only the first 400 characters of output, which usually cuts off the actual error.

## Context — read this first

jig is a Node/TypeScript CLI. Per slice, an implementer agent writes code, a reviewer agent
returns `{ approved, feedback }`, and the configured `verifyCommand` runs inside the sandbox.
The order is defined as a state machine in `src/flow/run-flow.ts` (`sliceFlow`); the steps are
in `src/steps/slice.ts`; the prompts in `src/prompts/slice.ts`. Code is layered
`domain` → `flow`/`steps` → `ports` → `adapters`. Specs sit beside the code. House rules are in
`.claude/rules/` — read `errors-as-values.md`, `testing-conventions.md` and
`clean-code-over-comments.md` first.

The current slice flow:

```ts
pending:    { step: implementSlice, on: { implemented: 'in_review', changesRequested: backToImplementUnlessCapped } },
in_review:  { step: reviewSlice,    on: { approved: 'verifying', changesRequested: backToImplementUnlessCapped } },
verifying:  { step: verifySlice,    on: { verified: 'approved', changesRequested: backToImplementUnlessCapped } },
```

## Target behaviour

1. **Order becomes implement → verify → review.** `implemented` goes to `verifying`; `verified`
   goes to `in_review`; the reviewer's `approved` goes to `approved`. A failing verify sends the
   slice back to the implementer without a review and counts as a review cycle, as today.
2. **No slice is approved without a passing verify.** A run saved by an older jig may resume with
   a slice already in `in_review` that was never verified. When `verifyCommand` is configured and
   the slice has no `verification` record, it must be verified before it can reach `approved`
   (e.g. a guard on `in_review`'s `approved` transition that routes to `verifying`). Cover this
   with a spec.
3. **The reviewer is told.** `reviewPrompt` states that `<command>` passed in the sandbox for
   this slice's commits, or that no verify command is configured and the reviewer should run the
   project's checks itself.
4. **Failure feedback is useful.** Replace `VERIFY_OUTPUT_LIMIT = 400` and the head-truncation
   with the **last** ~3000 characters of output (failures print last; `src/app/init-sandbox.ts`
   already uses `output.slice(-3000)`). Rewrite the message — it no longer says "The reviewer
   approved this slice, but…".

## Don't undo these

- `reviewCycleCap` still stops a slice (`stuck`) after that many rejections, whichever step
  rejected it.
- The reviewer prompt keeps the rule that scaffolding-only slices are rejected.
- jig never `throw`s; steps return `Result`.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it.

## Done when

- [ ] `src/flow/run-flow.spec.ts` shows implement → verify → review → approved, a verify failure
      going back to implement without a review, and an old `in_review` slice without a record
      being verified before approval
- [ ] `src/steps/slice.spec.ts` shows the reviewer prompt carrying the verify result and the
      failure feedback keeping the end of long output
- [ ] `grep -n "VERIFY_OUTPUT_LIMIT = 400" src` finds nothing
- [ ] `npm run validate -- --skip test:mutation` passes
