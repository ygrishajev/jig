## Errors Are Values

## Description

- **An expected failure is an `Err`; a bug is a `panic`.** A function that can fail for a reason the operator or the world can cause returns `Result<T, E>` (async: `Promise<Result<T, E>>`). A broken invariant — a phase out of order, a flow with no transition, a state that cannot happen — is `panic(message, cause?)` from `better-result`. jig code never uses `throw`; lint rejects it.
- **An operator-fixable failure is never a bug.** Docker down, a failing git command, a full disk, a held lock, an unreachable remote, a malformed file in the repo: each is an `Err` with a `JigError` class, printed plainly. The test: the operator must never get a stack trace for something jig did not get wrong. Add a class to `src/domain/errors.ts` when none fits.
- **Wrap a third-party call in the adapter that makes it.** simple-git, execa, sandcastle, fs and `JSON.parse` throw; the adapter turns that into an `Err` with `Result.try` / `Result.tryPromise` and maps it to a `JigError` there. Past the adapter nothing catches.
- **`try` wraps only the third-party call.** `Result.try` and `Result.tryPromise` hand any throw from `try` to `catch`, a `Panic` included, so wrapping jig code that can panic turns a bug into an ordinary `Err`. Keep `try: () => readFile(path)`; never `try: () => ourOwnFunction()`.
- **A `catch` may handle a third-party throw locally and on purpose, but never swallows a `Panic`.** A broad catch rethrows one untouched: `if (isPanic(error)) panic(messageOf(error), error)`. Re-raising after observing is `panic(message, cause)`, not `throw`.
- **Choose a narrow `E`.** `AgentSession.run` returns `Result<void, AgentRunFailed>`, not the whole `JigError` union. `Result<T, unknown>` and `Result<T, Error>` are a way of not choosing, so they are out. A function's `E` is the union of what its body can return, no wider.
- **Multi-step code uses `Result.gen`.** `yield*` stops at the first `Err`. A throw inside a generator body becomes a `Panic` ("generator body threw"); the original error is `rootCause(panic)` (`src/domain/errors.ts`).
- **Retry uses `retryResult`** (`src/domain/retry.ts`), which retries an `Err` the policy accepts and returns the last one. Never turn an `Err` back into a rejection to feed a retry library.
- **Never drop a `Result`.** An expression statement whose type is a `Result` (or a promise of one) is a lint error: return it, match on it, or bind it and handle it.
- **Cleanup after work.** When cleanup fails after the work succeeded, the cleanup failure is the `Err`. When it fails after the work failed, it is logged and the work's `Err` is kept (`reportCleanup` in `src/app/container.ts`).
- **The CLI prints an `Err` as its message and a throw unedited.** An `Err` that reaches `withErrorHandling` is an ordinary user error, printed as its message. Anything thrown is printed as it was first thrown — its own stack, under any panics wrapped around it — with no wording added. Both exit 1. "A throw is a bug" is how the code treats it, not text for the operator.

## Examples

### Good

```typescript
export async function readSettings(file: string): Promise<Result<Settings, ConfigInvalid>> {
  const text = await Result.tryPromise({
    try: () => readFile(file, 'utf8'),
    catch: (cause) => new ConfigInvalid({ message: `Cannot read ${file}: ${messageOf(cause)}` }),
  });
  return text.andThen(parseSettings);
}

function nextPhase(state: RunState): Phase {
  const next = PHASES[PHASES.indexOf(state.phase) + 1];
  if (!next) panic(`Run ${state.runId} has no phase after ${state.phase}`);
  return next;
}
```

### Bad

```typescript
export async function readSettings(file: string): Promise<Settings> {
  try {
    return parseSettings(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}`); // an expected failure thrown, its cause lost
  }
}

const result = await Result.tryPromise({
  try: () => nextSlice(state), // jig code that can panic: the Panic becomes an ordinary Err
  catch: (cause) => new AgentRunFailed({ message: messageOf(cause) }),
});

save(state); // drops a Result
```
