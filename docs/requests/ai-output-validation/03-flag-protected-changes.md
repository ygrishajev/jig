Treat this request as self-contained — everything needed is below; don't assume access to any
other issue or request. It lands after a change that moved verify before review in
`src/flow/run-flow.ts`; work on top of whatever `src/steps/slice.ts` and `src/prompts/slice.ts`
contain when you start.

## What

When an agent changes or deletes existing tests, or edits the configuration of the checks that
judge its work, the reviewer is told exactly which files and must justify each one or reject the
slice.

## Why

The agent writing the code can make the checks pass by weakening them — skip a test, delete an
assertion, relax a lint rule, change what `npm run verify` runs. The verify command runs from the
same files the agent just edited, so it cannot catch this. Today only the reviewer's attention
stands in the way, and nothing points it at these files.

## Context — read this first

jig is a Node/TypeScript CLI. Per slice, an implementer agent writes code in a sandbox, the
configured `verifyCommand` runs, then a reviewer agent reviews the slice's commits and returns
`{ approved, feedback }` (`reviewSlice` in `src/steps/slice.ts`, `reviewPrompt` in
`src/prompts/slice.ts`). The slice's commits are the range `<start>..HEAD`, where `start` comes
from `sliceStart()` in `src/steps/slice.ts`. Git access for steps goes through the `Workspace`
port (`src/ports/workspace.ts`), implemented in `src/adapters/git/git-workspace.ts`. Code is
layered `domain` → `flow`/`steps` → `ports` → `adapters`. Specs sit beside the code. House rules
are in `.claude/rules/` — read `callee-owns-its-rules.md`, `errors-as-values.md`,
`testing-conventions.md` first.

## Target behaviour

1. **jig lists the changed files.** Add a `Workspace` method that returns the files changed in a
   range with their change kind (added / modified / deleted / renamed), e.g. from
   `git diff --name-status <start>..HEAD`. Returns `Result<…, GitCommandFailed>`.
2. **jig decides which are protected.** One rule, in the domain (e.g. `src/domain/protected-paths.ts`):
   - test files — `*.spec.*`, `*.test.*`, anything under `test/`, `tests/`, `__tests__/`,
     snapshot files — when **modified, deleted or renamed** (adding a new test file is fine);
   - check configuration, any change: `package.json`, lint/format/typecheck config
     (`eslint.config.*`, `.eslintrc*`, `.prettierrc*`, `tsconfig*.json`, `biome.json`),
     test-runner and mutation config (`vitest.config.*`, `jest.config.*`, `stryker.conf.*`),
     CI workflows (`.github/workflows/*`), git hooks (`.husky/*`).
     Keep the list as one `as const` array of patterns; no config key in this change.
3. **The reviewer is told.** `reviewSlice` passes the protected changes to `reviewPrompt`, which
   lists them and says: for each, confirm the slice's description requires it and that it does
   not weaken a check (removed or skipped tests, loosened assertions, disabled rules, a narrower
   verify script); otherwise reject with feedback naming the file. With no protected changes the
   prompt says nothing extra.

## Don't undo these

- The reviewer prompt keeps its existing rules (review the whole range; reject scaffolding-only
  slices; reply `{ approved, feedback }`).
- Git commands in the adapter run with hooks off (`openRepoWithoutHooks`) — keep that.
- jig never `throw`s; a failing git call is `GitCommandFailed`, wrapped in the adapter.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it. Adapter specs run against a real temp git repo
(see `tests/support/temp-repo.ts`).

## Done when

- [ ] the protected-path rule has a spec covering an added test (not flagged), a modified and a
      deleted test (flagged), and each config category (flagged)
- [ ] `src/adapters/git/git-workspace.spec.ts` covers the new method on a real repo
- [ ] `src/steps/slice.spec.ts` shows protected changes reaching the reviewer prompt, and none
      when there are none
- [ ] `npm run validate -- --skip test:mutation` passes
