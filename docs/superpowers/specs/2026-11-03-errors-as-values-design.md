# Errors as Values

Date: 2026-11-03

## Problem

jig signals every failure by throwing. Its failures are already well typed — `src/domain/errors.ts`
has a `JigError` base with about twelve subclasses, each carrying a `kind` (`retry`, `block`,
`fatal`) that the engine acts on — but the types never reach a signature. A port documents what it
throws in a doc comment (`AgentSession.run`: "Throws `AgentRunFailed` …"); a caller learns of a
failure only by reading that comment or the implementation; a spec checks one with
`expect(...).rejects.toThrow`. And an expected failure and a bug travel the same path:
`src/flow/engine.ts` rethrows anything that is not a non-fatal `JigError`, and
`src/cli/with-error-handling.ts` prints a stray `TypeError` exactly like a bad config.

Today: about 53 `throw` statements in 27 of the 70 non-spec source files, about 29 `catch` sites,
about 80 `toThrow` / `rejects` assertions in specs, and 195 functions without a declared return
type in 52 files.

## Intent

Code that can fail says so in its signature, so callers and tests handle failure as a value. This
makes the code more testable and predictable.

- **jig code does not throw.** An expected failure is returned as an `Err`.
- **A thrown exception is a bug.** It is never a way to report something a caller should handle.
- **Every function declares its return type**, enforced by lint.

## Decisions

### Library: better-result

[better-result](https://github.com/dmmulroy/better-result) (v3, zero dependencies, ESM, actively
maintained). neverthrow was the first candidate and was rejected: no release since February 2025,
and its lint plugin is from 2022. better-result's model matches the intent directly — `Err` for
failures a caller can act on, `Panic` for broken invariants.

What the builder will use from it:

- `Result<T, E>`, `Result.ok`, `Result.err`. There is no separate async type: async code returns
  `Promise<Result<T, E>>`.
- `TaggedError` for error classes (real `Error` subclasses with a literal `_tag`, typed fields,
  exhaustive `matchError`).
- `Result.gen` with `yield*` for multi-step code that stops at the first `Err`.
- `Result.try` / `Result.tryPromise` to turn a third-party throw into an `Err`.
- `panic(message, cause?)` for a bug.

### Errors stay typed

- Each `JigError` subclass becomes a `TaggedError` class and keeps its `kind`. `SetupCommandFailed`
  keeps its `output`.
- `JigError` becomes the union of those classes, so `Err<JigError>` still reads the way it does
  today.
- A function's `E` is as narrow as it honestly can be. `AgentSession.run` returns
  `Promise<Result<void, AgentRunFailed>>`, not the whole union.
- `fatal` failures (`ConfigInvalid`, `RunRequestInvalid`, `RunInProgress`, `MetricsLogCorrupt`) are
  returned values too. They travel up to the CLI and are printed as ordinary user-facing errors.
- The engine reads `kind` from the `Err` instead of from a `catch`. The behaviour stays the same:
  `retry` gets bounded retries and then blocks the run, `block` blocks it straight away, and `fatal`
  ends the invocation.

### Bugs

- **Broken invariants are bugs.** `FlowHasNoTransition`, `FlowDoesNotSettle`, `PhaseOutOfOrder` and
  `NoCurrentSlice` today, plus the plain `throw new Error(...)` sites that guard against an
  impossible state (`withInput` wrapping a non-commander action). They stop being error classes and
  become `panic(...)` calls.
- The builder sorts each remaining plain `throw new Error(...)` into one of two piles. It is either
  a bug and becomes a `panic`, or an expected failure and gets a `JigError` class. Examples:
  `src/git/branch.ts:5`, `src/adapters/sandbox-image/docker-images.ts:36`,
  `src/adapters/run-store/git-remote-run-store.ts:127`.
- The builder sorts the error classes outside `errors.ts` that do not extend `JigError` the same
  way: `CommandInputInvalid` (`src/cli/with-input.ts`), `GitCommandFailed` and `MergeRefused`
  (`src/git/merge.ts`). `CommandInputInvalid` is bad user input, so it is an expected failure.
- **One top-level handler catches anything thrown** — a `Panic`, or a third-party throw nobody
  wrapped. It replaces today's catch-all in `with-error-handling.ts`. It prints what was first
  thrown, unedited — its own stack, not the panics wrapped around it — and sets exit code 1. It
  adds no wording of its own: "a throw is a bug" is how the code treats it, not a message.
  - An `Err` that reaches the CLI is printed as today: message only, exit code 1.
  - Keeping one exit code is my call. Splitting bugs onto their own code is a one-line change if
    wanted later.

### Third-party code

simple-git, execa, sandcastle, proper-lockfile, fs and `JSON.parse` throw or reject.

- **A failure the operator can fix is an expected failure.** Examples: Docker down, a git command
  failing, a full disk, a held lockfile, an unreachable remote, a malformed file in the repo. The
  adapter that makes the call wraps it with `Result.try` / `Result.tryPromise` and maps it to a
  `JigError` there. It adds new `JigError` classes where none fits.
  - The result is that nearly every port returns `Result`s: `AgentSession`, `Workspace`,
    `SandboxImages`, `RunStore`, and the git helpers in `src/git/`.
  - The test for this rule: the operator must never get a stack trace for something jig did not
    get wrong.
- **Only a failure that means jig itself is wrong is left to throw.** Examples: an unexpected throw
  inside our own logic, or a library violating its documented contract. It reaches the top-level
  bug handler.
- **A `catch` may still handle a third-party throw locally and on purpose.** Today's
  `.catch(() => undefined)` sites (`readRepoFile`, `abortMergeInProgress`, `latest-agent-versions`,
  `repository.ts`, `usage.ts`, the metrics-log JSON parse) can stay as they are or move to
  `Result.try`; the builder chooses per site.
- **A `catch` must never swallow a `Panic`.** Any catch that catches broadly rethrows a `Panic`
  untouched, with `if (isPanic(error)) panic(…, error)` or the library's equivalent. Example: the
  observer guard in `src/observers/run-events.ts` still logs and swallows a failing observer, but
  lets a `Panic` through.

### Re-raising after observing

Some code catches an error only to record it and pass it on. `Engine.run` publishes `runFailed`,
and `Engine.timed` publishes `stepFailed`.

- For an `Err`, there is nothing to catch any more: the code inspects the returned value.
- For a thrown bug, a `catch` may observe it and re-raise it with `panic(message, cause)`. Plain
  `throw` is not allowed even there. `try/finally` is fine where no observation of the error is
  needed.

### Retry

Today p-retry drives three retries, and all of them depend on a throw:

- steps in `Engine.attempt`
- `openSessionRetrying` in `src/app/container.ts`
- `remoteCall` in `git-remote-run-store.ts`

better-result's retry only works on `Result.tryPromise`, which retries a rejecting promise. Using it
here would mean turning an `Err` back into a rejection, which is a throw used as control flow.

So jig gets one small typed retry over `Promise<Result<T, E>>`:

- it takes the number of retries, a delay, a `shouldRetry(error)` predicate and an
  `onFailedAttempt` hook
- it returns the last `Err` when it gives up
- p-retry is removed
- the PR gives this reason, as `CLAUDE.md` requires
- events stay the same: `stepRetried` and the sandbox-retry warning

This was my call; the user did not decide it.

### Enforcement

- **Lint, scoped to non-spec source under `src/`:**
  - `no-restricted-syntax` on `ThrowStatement`. `panic()` is a call, so it needs no exemption.
  - `@typescript-eslint/explicit-function-return-type` with `allowExpressions` and
    `allowTypedFunctionExpressions`, so inline callbacks such as `.map(x => …)` stay unannotated.
  - `@typescript-eslint/no-floating-promises`. It has no violations today.
  - A repo-local, type-aware rule `jig/no-ignored-result`. It flags an expression statement whose
    type, or awaited type, is a better-result `Ok` / `Err`. It lives beside the existing
    `scripts/eslint-rules/declarations-in-call-order.ts`, with its own spec.
  - These rules need type information, so that config block turns on
    `parserOptions.projectService`.
- **Specs are exempt from the return-type rule.** `testing-conventions.md` already says a spec's
  `setup` has no declared return type.
- **A spike on 2026-11-03 confirmed all four rules run on ESLint 9.39** against a probe file. The
  spike also confirmed `no-ignored-result` catches both a dropped sync `Result` and an awaited,
  dropped `Promise<Result>`. Counts against today's code: 195 missing return types, 53 throws,
  0 floating promises.
- **A new house rule, `.claude/instructions/errors-as-values.md`, linked from `CLAUDE.md`.** It
  covers:
  - when to return an `Err` and when a throw is a bug
  - when to wrap a third-party call
  - how to choose a narrow `E`
  - how to test both
- **Update to an existing house rule:** `testing-conventions.md` says expected failures are
  asserted on the returned `Err` (its class / `_tag` and the fields the code decided), never with
  `toThrow`. `toThrow` remains only for a `Panic`.
- **"Throws …" doc comments on ports are deleted.** The signature now carries that.

## Rollout

Staged. Each stage lands green: lint, typecheck, unit tests, and the mutation score not lower. The
order below is my reading of "let's try with eslint":

1. **Return types.** Turn on `explicit-function-return-type` and declare the 195 return types. This
   is mechanical, has no behaviour change, and makes the later signature changes visible in diffs.
2. **Results through ports and adapters.** Add better-result, convert the error classes to
   `TaggedError`, and change ports and their adapters and fakes to return `Result`s. Callers in
   steps, the engine and `app/` adapt as needed.
3. **Steps, engine, app, CLI.** Steps return `Promise<Result<Outcome, JigError>>`, the engine
   applies the failure policy to `Err`s, and the CLI gets the two-path top-level handler. Then turn
   on the `throw` ban, `no-floating-promises` and `no-ignored-result`, and write the house rule.

Stage 2 and 3 can merge into one PR if splitting them makes the intermediate state awkward. That is
the builder's call.

## Non-goals

- No change to which failures are `retry`, `block` or `fatal`, or to what the engine does with each.
- No change to user-visible error messages.
- No wrapping of every third-party call "just in case".
- No new functional-programming layer beyond what better-result provides (no Effect, no `Option`
  type).

## Anti-goals

- A thrown exception used as control flow anywhere in jig's own code, including to drive a retry.
- `Result<T, unknown>` or `Result<T, Error>` as a way to dodge choosing an error type.
- A bug printed as if it were an ordinary user error, or an ordinary user error printed with a
  stack trace.

## Left to the builder

- **The shape of the top-level handler,** and whether `withErrorHandling` keeps its name.
- **Exact PR boundaries within the stages above.**

## Behaviour changes found after landing

- **A git failure inside a step now blocks the run.** Before, simple-git's throw was not a
  `JigError`, so the engine rethrew it and the invocation ended. Now it is a `GitCommandFailed`,
  whose kind is `block`, so the run blocks with git's message and can be resumed. This goes against
  the non-goal above; it is kept because a git failure is the operator's to look at, not a crash.
