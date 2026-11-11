Treat this request as self-contained — everything needed is below; don't assume access to any
other issue or request.

## What

The pull request jig opens says truthfully whether the project's checks were run and passed. Today
it can say "not run" for checks that ran and passed on every slice.

## Why

A reviewer reads the pull request description first. If it says checks were not run when they
were, the reviewer wastes time re-running them or distrusts the run. If it ever said they passed
when they did not, the reviewer would be misled. The facts are known to jig; they should not
depend on an agent guessing.

## Context — read this first

jig is a Node/TypeScript CLI that turns a markdown request into planned slices; per slice an
implementer agent writes code, a reviewer agent approves or rejects it, and then the configured
`verifyCommand` (e.g. `npm run verify`) runs inside the sandbox. Code is layered
`domain` → `flow`/`steps` → `ports` → `adapters`. Steps never change state: they return an
`Outcome` (`src/domain/outcome.ts`) and `applyOutcome` (`src/domain/apply-outcome.ts`) folds it
into run state. Specs sit beside the code (`slice.ts` → `slice.spec.ts`). House rules are in
`.claude/rules/` — read `errors-as-values.md`, `testing-conventions.md` and
`clean-code-over-comments.md` before writing code.

## The problem, exactly

- `verifySlice` in `src/steps/slice.ts` returns `{ type: 'verified' }` both when the verify
  command exited 0 **and** when no `verifyCommand` is configured
  (`if (!command) return Result.ok<Outcome>({ type: 'verified' });`). So a slice's `approved`
  status does not tell you whether anything was run.
- The PR describer agent (`src/prompts/pull-request.ts`, the rule starting
  `'- Only report verification you can back up.'`) is told to tick a check only if it ran it
  itself. It is never told what jig ran, runs nothing, and writes "not run".

## Target behaviour

1. **Record the result on the slice.** When the verify command exits 0, the `verified` outcome
   carries `{ command }`, and `applyOutcome` stores it on the slice as
   `verification: { command: string }` (add the optional field to `sliceSchema` in
   `src/domain/slice.ts`). When no `verifyCommand` is configured, nothing is stored. When a slice
   goes back to `pending` (`changesRequested`), any stored `verification` is cleared — it belonged
   to an earlier commit.
2. **jig writes the verification facts itself.** `renderPullRequest` in
   `src/steps/pull-request-description.ts` adds a short `### Verification by jig` block (inside or
   just before the collapsed "Agent run" section — your call, keep it visible) built only from
   state:
   - every approved slice has a record → "`<command>` passed in the sandbox on every slice (N/N)."
   - no `verifyCommand` configured → "No verify command is configured, so jig ran no checks."
   - otherwise list which slices passed and which did not.
3. **The describer is told the facts.** `pullRequestPrompt` receives the per-slice verification
   (e.g. in `sliceLines`, `- [approved, verify passed: npm run verify] id: …`) and the rule is
   rewritten: report the verification jig recorded as fact; do not run checks; do not claim
   anything beyond it.

## Don't undo these

- Steps never mutate state; only `applyOutcome` does.
- jig never `throw`s; expected failures are `Result.err`, bugs are `panic` (lint enforces it).
- Saved runs from older versions have slices without `verification` — the field must be
  optional and old state must still load.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it.

## Done when

- [ ] `src/steps/slice.spec.ts` covers: verified with a command records it; no command records
      nothing; `changesRequested` clears it
- [ ] `src/domain/apply-outcome.spec.ts` covers the new field
- [ ] a spec for `renderPullRequest` covers the three verification wordings above
- [ ] the describer prompt contains the recorded verification and no longer says "only if you ran
      it here"
- [ ] `npm run validate -- --skip test:mutation` passes
