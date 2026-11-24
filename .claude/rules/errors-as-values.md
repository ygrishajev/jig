---
paths:
  - 'src/**/*.ts'
  - 'scripts/**/*.ts'
---

## Errors Are Values

## Description

- **An expected failure is an `Err`; a bug is a `panic`.** A function that can fail for a reason the operator or the world can cause returns `Result<T, E>` (async: `Promise<Result<T, E>>`). A broken invariant — a phase out of order, a flow with no transition, a state that cannot happen — is `panic(message, cause?)` from `better-result`. jig code never uses `throw`; lint rejects it. Specs are held to this too, with one exception: a fake may throw what the real thing it stands in for throws (`throw failure`). A guard on the test's own assumptions — an unscripted call, a result of the wrong kind — is `panic`, and lint rejects `throw new Error('…')` in a spec.
- **An operator-fixable failure is never a bug.** Docker down, a failing git command, a full disk, a held lock, an unreachable remote, a malformed file in the repo: each is an `Err` with a failure class from the owner of what it means, printed plainly. The test: the operator must never get a stack trace for something jig did not get wrong.
- **A failure class is defined once, by the owner of what it means to callers.** Domain owns business conditions, such as an unresolved design or a plan that does not cover the request. A port owns the failures of its capability contract — storage, Git and sandbox failures belong with the store, Git and sandbox ports, without raw library details. Config owns configuration-validation failures, unless the failure is part of a capability contract that callers share. The CLI owns transport input failures; the app owns failures of its use cases. A capability failure does not belong in domain because many modules return it, and a broad historical name such as `ConfigInvalid` is no evidence that its uses mean one thing.
- **Wrap a third-party call in the adapter that makes it.** simple-git, execa, sandcastle, fs and `JSON.parse` throw; the adapter turns that into an `Err` with `Result.try` / `Result.tryPromise` and translates it to the failure its capability declares. Past the adapter nothing catches.
- **`try` wraps only the third-party call.** `Result.try` and `Result.tryPromise` hand any throw from `try` to `catch`, a `Panic` included, so wrapping jig code that can panic turns a bug into an ordinary `Err`. Keep `try: () => readFile(path)`; never `try: () => ourOwnFunction()`.
- **A `catch` may handle a third-party throw locally and on purpose, but never swallows a `Panic`.** A broad catch rethrows one untouched: `if (isPanic(error)) panic(messageOf(error), error)`. Re-raising after observing is `panic(message, cause)`, not `throw`.
- **Choose a narrow `E`.** `AgentSession.run` returns `Result<void, AgentRunFailed>`, not every failure jig has. `Result<T, unknown>` and `Result<T, Error>` are a way of not choosing, so they are out. A function's `E` is the union of what its body can return, no wider. An aggregate union belongs at the application boundary that actually needs one; domain and flow never import an app-wide union to recognise a failure.
- **Multi-step code uses `Result.gen`.** `yield*` stops at the first `Err`. A throw inside a generator body becomes a `Panic` ("generator body threw"); the original error is `rootCause(panic)` (`src/failures/messages.ts`).
- **Retry uses `retryResult`** (`src/failures/retry.ts`), which retries an `Err` the policy accepts and returns the last one. Never turn an `Err` back into a rejection to feed a retry library. The attempt count comes from the resolved `RunSettings`, not a constant at the call site; a step retry uses `transientRetryPolicy` (`src/flow/retry-policy.ts`).
- **Never drop a `Result`.** An expression statement whose type is a `Result` (or a promise of one) is a lint error: return it, match on it, or bind it and handle it.
- **Cleanup after work.** When cleanup fails after the work succeeded, the cleanup failure is the `Err`. When it fails after the work failed, it is logged and the work's `Err` is kept (`reportCleanup` in `src/app/report-cleanup.ts`). Acquire and release through `withResource` and `releaseInOrder` (`src/app/lifecycle.ts`): every release is attempted, the first failed one is the cleanup failure and later ones are logged, and a panic in the work or a release still releases the rest and then propagates as it was thrown, with any cleanup that fails or panics after it logged. A partial acquisition releases what it holds through `releasingOnPanic`.
- **The CLI prints an `Err` as its message and a throw unedited.** An `Err` that reaches `withErrorHandling` is an ordinary user error, printed as its message. Anything thrown is printed as it was first thrown — its own stack, under any panics wrapped around it — with no wording added. Both exit 1. "A throw is a bug" is how the code treats it, not text for the operator.

## Target and current layout

Failure ownership above is the target in [`docs/specs/application-boundaries.md`](../../docs/specs/application-boundaries.md), and the classes live with their owners; there is no app-wide union or registry of every class. Domain keeps business failures (`PlanNotCovered`, `DesignUnresolved`), `FailureKind` and `isTransient` in `src/domain/errors.ts`. Ports own capability failures: the agent session and sandbox in `src/ports/agent-session.ts`, the workspace in `src/ports/workspace.ts`, images in `src/ports/sandbox-images.ts`, the run store in `src/ports/run-store.ts`, the GitHub API and its setup in `src/ports/github.ts`, run-branch publication in `src/ports/run-branches.ts`, GitHub publication receipts and leases in `src/ports/publication-receipts.ts`, and the failures several contracts share in `src/ports/git-failures.ts`, `src/ports/run-state-failures.ts` and `src/ports/local-state.ts`. Config owns `ConfigInvalid` (`src/config/errors.ts`) for configuration validation only; a different meaning gets its own class and tag, as `GithubSettingsInvalid` does for the GitHub settings, which `implementGithubIssue` reports as the port's `GithubSetupInvalid`. The app owns its use-case failures (`src/app/errors.ts`); `RunStoreSetupInvalid` belongs to the store catalog contract in `src/ports/run-store.ts`; the CLI owns `CommandInputInvalid` (`src/cli/with-input.ts`). Import a class from its owner's module; no module re-exports another's. The one route outside app and composition is the app's own public entry: the CLI imports an app failure such as `RunRequestInvalid` from `src/app/api.ts`, never from `src/app/errors.ts`. Flow names what a step may return (`StepFailure`) and what the engine returns (`EngineFailure`) from those classes in `src/flow/define-flow.ts` and `src/flow/engine.ts`. `messageOf`, `rootCause`, `retryResult` and `RetryPolicy` live in `src/failures/`, which imports no other project source; callers import them directly, and domain, ports, config and prompts do not import it. Flow assembles the step retry policy: `transientRetryPolicy` in `src/flow/retry-policy.ts` returns a `RetryPolicy` from the resolved `RunSettings` and `isTransient`, and domain exports no retry-policy builder or type shaped like `RetryPolicy`. A class split out of `ConfigInvalid` is logged under the `ConfigInvalid` identity by `serializeError` (`src/adapters/logging/error-serializer.ts`), the one place that translates a tag for old logs.

## Examples

### Good

```typescript
export function currentBranch(git: SimpleGit): Promise<Result<string, GitCommandFailed>> {
  const command = 'git rev-parse --abbrev-ref HEAD';
  return Result.tryPromise({
    try: () => git.revparse(['--abbrev-ref', 'HEAD']),
    catch: (cause) =>
      new GitCommandFailed({ message: `${command} failed`, command, output: messageOf(cause) }),
  });
}

function nextPhase(state: RunState): Phase {
  const next = PHASES[PHASES.indexOf(state.phase) + 1];
  if (!next) panic(`Run ${state.runId} has no phase after ${state.phase}`);
  return next;
}
```

### Bad

```typescript
export async function currentBranch(git: SimpleGit): Promise<string> {
  try {
    return await git.revparse(['--abbrev-ref', 'HEAD']);
  } catch (error) {
    throw new Error('Cannot read the current branch'); // an expected failure thrown, its cause lost
  }
}

// a Git capability failure put in domain because the store, workspace and steps all return it
export class BranchMissing extends TaggedError('BranchMissing')<{ message: string }> {}

const result = await Result.tryPromise({
  try: () => nextSlice(state), // jig code that can panic: the Panic becomes an ordinary Err
  catch: (cause) => new AgentRunFailed({ message: messageOf(cause) }),
});

save(state); // drops a Result
```
