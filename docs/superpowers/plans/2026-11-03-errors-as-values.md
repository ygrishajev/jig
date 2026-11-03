# Errors as Values Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** jig's own code stops throwing. Expected failures come back as typed better-result `Err`s, a throw means a bug, and every non-spec function declares its return type, all enforced by lint.

**Architecture:**

- **Bottom up.** Types and lint first. Then the error classes and a typed retry. Then each port with its adapters and fakes. Then steps and the engine, then app and CLI. Enforcement and house rules come last.
- **Transitional bridge.** Until the steps and engine are converted, unconverted callers bridge a returned `Err` with a transitional `orThrow`. It is deleted in Task 11, and the `throw` ban then proves nothing is left.

**Tech Stack:** TypeScript (NodeNext, strict), better-result v3, ESLint 9 flat config with typescript-eslint, Vitest with vitest-mock-extended and faker.

**Spec:** `docs/superpowers/specs/2026-11-03-errors-as-values-design.md`. Read it before any task.

## Completion status

Tasks 1–10 were implemented in the existing branch commits. Task 11 completes enforcement,
removes the transitional bridge from production code and specs, and adds the house rules.
The final validation command excludes mutation testing at the user's request.

Validation also found duplicate issue formatting and phase-step handling from earlier slices.
Issue formatting now shares one helper while retaining each caller's separator; phase steps
propagate failures with `Result.gen`. Regression tests cover issue paths and separators, and
lint tests cover synchronous, promised, awaited, `Ok`, and `Err` results.

## Global Constraints

- **Library and result types:**
  - better-result is the only Result library. No neverthrow, no Effect, no `Option` type.
  - Async code returns `Promise<Result<T, E>>`.
- **Error types:**
  - `E` is as narrow as it honestly can be.
  - `Result<T, unknown>` and `Result<T, Error>` are forbidden.
  - Error classes are better-result `TaggedError` classes that keep their `kind: 'retry' | 'block' | 'fatal'`.
  - `JigError` is the union of them.
- **Expected failures:**
  - A failure the operator can fix is an expected failure and is returned as an `Err`. Examples: Docker down, git failing, a full disk, a held lock, an unreachable remote, a malformed repo file.
  - The operator must never see "this is a bug" for something jig did not get wrong.
- **Bugs:**
  - A broken invariant is `panic(message, cause?)` from better-result.
  - No `throw` statement in non-spec `src/` code once Task 11 lands, not even to re-raise.
- **Catches:**
  - A `catch` may handle a third-party throw locally and on purpose.
  - A `catch` never swallows a `Panic`.
- **Retry:** done by jig's typed retry (Task 3), never by throwing. p-retry is removed.
- **No behaviour change beyond these:**
  - which failures are `retry` / `block` / `fatal`
  - what the engine does with each
  - every user-visible message except the new bug message
  - events (`stepRetried`, `stepFailed`, `runFailed`, `runBlocked`, the sandbox-retry warning)
- **Exit code:** 1 for an ordinary error and for a bug alike.
- **Return types:** required in non-spec `src/` and `scripts/` code. Specs are exempt; `setup` keeps no declared return type.
- **House rules:** every task follows `CLAUDE.md` and `.claude/instructions/*`:
  - `setup` function, not `beforeEach`
  - `mock<T>()`, not `as unknown as`
  - faker builders
  - declarations in call order
  - no `vi.mock`
- **Commits:**
  - conventional, with a scope from `.commitlintrc.json`
  - a change under `src/` is `refactor`, never `chore`
  - end each message with the session's attribution lines

## Review Focus

1. **Docker down when a run starts.**
   - Expected: `jig run` prints "Could not start the sandbox: …" as an ordinary error after the bounded retries, exit 1, no stack, no "bug" wording.
   - Pinned in Task 6: `openSessionRetrying` returns the last `SandboxUnavailable`.
   - Pinned in Task 10: the CLI prints an `Err` without a stack.
2. **A malformed `jig.config.json`** (invalid JSON or an unknown key).
   - Expected: an ordinary `ConfigInvalid` message naming the file, never a stack trace.
   - Today `JSON.parse` / zod throw raw. Pinned in Task 4.
3. **Run started on a detached HEAD, or outside the repo root.**
   - Expected: an ordinary error telling the operator what to check out or where to run from.
   - Pinned in Task 4 (`ensureRepositoryRoot`) and Task 5 (`getCurrentBranch`).
4. **An observer that fails.**
   - An ordinary throw is logged as a warning and the run continues.
   - A `Panic` reaches the top-level handler.
   - Pinned in Task 10.
5. **The remote rejects a push.**
   - A lease rejection is `RunStateConflict` (block, not retried).
   - A network failure is `RemoteUnavailable` (retried `REMOTE_RETRIES` times), and the last `Err` is returned.
   - Pinned in Task 7.

---

### Task 1: Declare every return type

Stage 1 of the rollout. It is mechanical and changes no behaviour.

**Files:**

- Modify: `eslint.config.js`
- Modify: every non-spec `.ts` under `src/` and `scripts/` that the rule flags (195 sites in 52 files when the spike ran)

**Interfaces:**

- Produces: the lint block that later tasks extend. Non-spec `src/**/*.ts` and `scripts/**/*.ts` get `@typescript-eslint/explicit-function-return-type: ['error', { allowExpressions: true, allowTypedFunctionExpressions: true }]`.

- [ ] **Step 1: Add the rule** to the existing non-spec `src/**/*.ts` block in `eslint.config.js`, and to a matching non-spec `scripts/**/*.ts` block.
- [ ] **Step 2: Run `npm run lint`.** Expected: FAIL, with about 195 `explicit-function-return-type` errors.
- [ ] **Step 3: Declare each return type.**
  - Write the type the function returns today. Name an existing type where one exists (`RunStep`, `EngineResult`, a port's method type); don't spell out a structural literal.
  - Where inference produced an anonymous object type, either add a named `interface` beside the function or use `ReturnType<typeof …>` only if a name would be noise.
  - Class methods that implement a port use the port's types.
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass, with zero `explicit-function-return-type` errors.
- [ ] **Step 5: Commit.** `refactor(dx): declare the return type of every function`

---

### Task 2: Error classes become tagged errors; invariants become panics

**Files:**

- Modify: `package.json` (add `better-result` ^3)
- Modify: `src/domain/errors.ts`, `src/domain/errors.spec.ts`
- Modify: `src/flow/engine.ts` (`FlowDoesNotSettle`, `FlowHasNoTransition`)
- Modify: `src/domain/run-state.ts` (`PhaseOutOfOrder`), `src/domain/apply-outcome.ts` (`NoCurrentSlice`)
- Modify: `src/cli/with-input.ts` (the "must wrap a commander action" guard)
- Modify: every `new <ErrorClass>('…')` call site, and the specs asserting on those four bug classes

**Interfaces:**

- Produces, in `src/domain/errors.ts`:
  - **Error classes.** One `TaggedError` class per existing class: `AgentRunFailed`, `AgentOutputInvalid`, `RemoteUnavailable`, `SandboxUnavailable`, `SetupCommandFailed`, `RunStateConflict`, `MergeFailed`, `ConfigInvalid`, `RunRequestInvalid`, `RunInProgress`, `MetricsLogCorrupt`.
    - Shape: `class X extends TaggedError('X')<{ message: string }> { readonly kind = '<as today>' as const }`.
    - `SetupCommandFailed`'s fields are `{ message: string; output: string }`.
    - Construction becomes `new X({ message })`.
  - `export type JigError = AgentRunFailed | … | MetricsLogCorrupt` (the full union, including the classes Tasks 5 and 10 add).
  - `export type FailureKind = 'retry' | 'block' | 'fatal'` (unchanged).
  - `export function isTransient(error: JigError): boolean`. It now takes a `JigError`, not `unknown`.
  - `export function messageOf(error: unknown): string` (unchanged).
  - `export function orThrow<T, E>(result: Result<T, E>): T`. It is TRANSITIONAL: it returns the value or throws the error, and carries a one-line comment saying Task 11 deletes it.
- Produces, as bugs: the four invariant sites call `panic(…)` with today's message. Their classes are deleted.

- [ ] **Step 1: Write the failing tests** in `src/domain/errors.spec.ts`:
  - `it('marks a sandbox that did not start as worth another attempt')`: `expect(isTransient(new SandboxUnavailable({ message: faker.lorem.sentence() }))).toBe(true)`
  - `it('does not retry a failure that needs a person')`: `isTransient(new MergeFailed({ message }))` is `false`, and so is `isTransient(new ConfigInvalid({ message }))`
  - `it('keeps the setup command output on the error')`: `new SetupCommandFailed({ message, output }).output` equals `output`
- [ ] **Step 2: Run `npx vitest run src/domain/errors.spec.ts`.** Expected: FAIL, because the constructors take a string.
- [ ] **Step 3: Implement the classes, the union, `isTransient` and `orThrow`.** Install better-result with `npm install better-result@^3`. Update every construction site to `new X({ message })`.
- [ ] **Step 4: Replace the four invariant classes with `panic(...)`** at their sites, and the `withInput` guard with `panic('withInput must wrap a commander action')`. In specs that asserted those classes, assert `.toThrow(Panic)`. Engine specs that expected `FlowHasNoTransition` to surface as a fatal failure now expect a `Panic`.
- [ ] **Step 5: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 6: Commit.** `refactor(domain): make jig's errors tagged errors and its invariants panics`

---

### Task 3: A typed retry over Results

**Files:**

- Create: `src/domain/retry.ts`, `src/domain/retry.spec.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface RetryPolicy<E> {
    retries: number; // attempts after the first
    delayMs: number; // before the first retry; doubles before each later one (p-retry's default factor)
    shouldRetry(error: E): boolean;
    onFailedAttempt?(failure: { error: E; attempt: number; retriesLeft: number }): void;
  }
  export function retryResult<T, E>(
    operation: () => Promise<Result<T, E>>,
    policy: RetryPolicy<E>,
  ): Promise<Result<T, E>>;
  ```
- Behaviour:
  - Returns the first `Ok`.
  - Stops at the first `Err` that `shouldRetry` rejects, or when no retries are left, and returns that `Err`.
  - Calls `onFailedAttempt` after every failed attempt, the last one included, with `retriesLeft` counting down to 0.
  - A throw from `operation` is not caught: it is a bug.

- [ ] **Step 1: Write the failing tests** (`delayMs: 0` throughout):
  - `it('returns the first success without retrying')`: the operation is called once.
  - `it('retries a retryable failure until it succeeds')`: `Err`, `Err`, then `Ok(value)` with `retries: 3` gives `Ok(value)` and 3 calls.
  - `it('gives up after the last retry with the last failure')`: always `Err(eN)` with `retries: 2` gives `Err(e3)` and 3 calls.
  - `it('stops at a failure it should not retry')`: `shouldRetry` returns false, so there is one call and that `Err` is returned.
  - `it('reports each failed attempt with the retries left')`: `onFailedAttempt` is called with `{ attempt: 1, retriesLeft: 2 }`, then `{ attempt: 2, retriesLeft: 1 }`, then `{ attempt: 3, retriesLeft: 0 }`.
  - `it('lets a thrown bug through')`: an operation that throws makes `retryResult` reject with that error.
- [ ] **Step 2: Run `npx vitest run src/domain/retry.spec.ts`.** Expected: FAIL, "retryResult is not exported".
- [ ] **Step 3: Implement `retryResult`.** Sleep with `setTimeout` from `node:timers/promises`.
- [ ] **Step 4: Run the spec.** Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(domain): add a retry that works on Results instead of throws`

---

### Task 4: Environment, config and repository root at the edge

**Files:**

- Modify: `src/config/environment.ts`, `src/config/load-config.ts`, `src/config/write-config.ts`, `src/git/repository.ts`, `src/cli/with-app.ts`, `src/app/container.ts`, and their specs

**Interfaces:**

- Consumes: `ConfigInvalid` and `orThrow` (Task 2).
- Produces:
  - `parseEnvironment(raw: NodeJS.ProcessEnv): Result<JigEnvironment, ConfigInvalid>`
  - `loadConfig(repoRoot: string): Result<JigConfig, ConfigInvalid>`
    - Invalid JSON gives `ConfigInvalid`: `jig.config.json is not valid JSON: <parser message>`.
    - A zod failure gives `ConfigInvalid`: `jig.config.json is not valid — <path: message; …>`, in the same format `parseEnvironment` uses.
  - `updateConfigFile(repoRoot, values): Promise<Result<void, ConfigInvalid>>`
  - `ensureRepositoryRoot(cwd: string): Promise<Result<void, ConfigInvalid>>`
  - `createAppContainer` takes `config: JigConfig` as an input and registers it with `asValue`, because awilix factories cannot return a `Result`. Its `settings` factory is unchanged.
  - `withApp`:
    - checks the repository root
    - parses the environment
    - loads the config
    - only then builds the container
    - returns `Promise<Result<T, JigError>>` when `command` returns `Promise<Result<T, JigError>>`

    Until Task 10, the commands bridge it with `orThrow`.

- [ ] **Step 1: Write the failing tests.**
  - `load-config.spec.ts`:
    - `it('reports a config file that is not JSON as invalid config')`: write `{"mergeMode":` to the temp repo. `loadConfig(repo)` gives `isErr()`, `error` is an instance of `ConfigInvalid`, and `error.message` contains `jig.config.json`.
    - `it('reports an unknown key as invalid config')`: `{"mergeMod":"auto"}` gives a `ConfigInvalid` whose message contains `mergeMod`.
  - `environment.spec.ts`: change the existing "invalid environment" test to assert on the `Err`.
  - `with-app.spec.ts`: `it('does not build the app outside the repository root')` gives an `Err` of `ConfigInvalid`, and the `command` is never called.
- [ ] **Step 2: Run those specs.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use `Result.try` around `JSON.parse`, and `safeParse` for zod.
  - In `ensureRepositoryRoot`, keep the existing `.catch(() => undefined)`: it handles a non-repository on purpose.
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(config): return config and environment failures as values`

---

### Task 5: Git helpers and the Workspace port

**Files:**

- Modify: `src/git/branch.ts`, `src/git/merge.ts`, `src/git/repository.ts`, `src/ports/workspace.ts`, `src/adapters/git/git-workspace.ts`
- Modify: `src/steps/slice.ts`, `src/steps/finishing.ts`, `src/app/run-jig.ts`, `src/app/container.ts` (callers)
- Modify: the specs and fakes of the files above

**Interfaces:**

- Consumes: Task 2's error classes and `orThrow`.
- Produces:
  - **New errors in `errors.ts`:**
    - `GitCommandFailed`: `kind: 'block'`, fields `{ message; command: string; stderr: string }`. It replaces the class in `merge.ts`.
    - `MergeRefused` folds into `MergeFailed`, so `MergeRefusal` reasons are carried in the message. Keep the `reason` field on `MergeFailed` only if a spec or caller reads it.
  - **Git helpers:**
    - `getCurrentBranch(cwd): Promise<Result<string, ConfigInvalid>>`. On a detached HEAD the message is `"<cwd> has no branch checked out — check out the branch the run should start from."`
    - `deleteBranch(cwd, name): Promise<Result<void, GitCommandFailed>>`
    - `commitAll(cwd, message): Promise<Result<string | null, GitCommandFailed>>`
    - `isWorkingTreeClean(cwd): Promise<Result<boolean, GitCommandFailed>>`
    - `isBranchMergedInto(...): Promise<Result<boolean, GitCommandFailed | RemoteUnavailable>>`
    - `mergeBranchInto(...): Promise<Result<string, MergeFailed | GitCommandFailed>>`
  - **The `Workspace` port.** Every method returns `Promise<Result<…, E>>`:
    - `commitAll`, `headCommit`, `forkPoint`, `summariseCommitsSince`: `E = GitCommandFailed`
    - `readRepoFile`: stays `Promise<string | undefined>`. Its `catch` handles a missing file on purpose.
    - `mergeRunBranch`: `E = MergeFailed`
    - `isRunBranchMerged`: `E = GitCommandFailed | RemoteUnavailable`
  - **Wrapping.** simple-git calls are wrapped with `Result.tryPromise({ try, catch: (e) => new GitCommandFailed({ message: \`git ${cmd} failed: ${messageOf(e)}\`, command, stderr: messageOf(e) }) })`.
  - **Callers until Task 9.** Steps call these through `orThrow`.

- [ ] **Step 1: Write the failing tests** against the real temp repo (`tests/support/temp-repo.ts`):
  - `branch.spec.ts`: `it('reports a detached HEAD as something the operator fixes')`. Check out a commit; `getCurrentBranch` gives a `ConfigInvalid` `Err`.
  - `merge.spec.ts`: change the existing refusal tests (base not checked out, uncommitted changes) to assert an `Err` of `MergeFailed` and that the operator's tree is unchanged.
  - `git-workspace.spec.ts`: `it('aborts a conflicting merge and reports it as a failed merge')`. Assert a `MergeFailed` `Err`, and `git status` shows no merge in progress.
- [ ] **Step 2: Run those specs.** Expected: FAIL.
- [ ] **Step 3: Implement the helpers, the port, the adapter and the fakes.** Update the step and app callers with `orThrow`.
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(git): return git failures as values through the Workspace port`

---

### Task 6: The AgentSession port and opening a sandbox

**Files:**

- Modify: `src/ports/agent-session.ts`
- Modify: `src/adapters/sandcastle/sandcastle-session.ts`, `structured-output.ts`, `codex-auth.ts`, `agents.ts`, `open-session.ts`, `sandcastle-env.ts`
- Modify: `src/app/container.ts`, `src/app/init-sandbox.ts`
- Modify: the specs and the fake agent session

**Interfaces:**

- Consumes: `retryResult` (Task 3); Task 2's errors; `orThrow`.
- Produces:
  - **`AgentSession`:**
    - `run(input): Promise<Result<void, AgentRunFailed>>`
    - `runForOutput<T>(input): Promise<Result<T, AgentRunFailed | AgentOutputInvalid>>`
    - `exec(command): Promise<ExecResult>`. Unchanged: an exit code is data, not a failure.
    - The "Throws …" doc comments are deleted.
  - **Parsing and agents:**
    - `extractOutput<T>(reply, schema): Result<T, AgentOutputInvalid>`. `parseWithCorrections` loops on the `Err` with no `catch`.
    - `AGENTS[name].create(model)` and `collectCredentials(...)` return `Result<…, ConfigInvalid>` where they throw today.
  - **Codex auth:** `openCodexAuthCache(dir): Promise<Result<CodexAuthCache, ConfigInvalid>>`
  - **Opening a sandbox:**
    - `SandcastleSession.open(options, start?): Promise<Result<SandcastleSession, ConfigInvalid | SandboxUnavailable | SetupCommandFailed>>`
    - `openSandcastleSession(context, input)` returns the same `Result`.
    - Sandcastle's rejection is caught by `Result.tryPromise` and mapped by the existing `sandboxStartFailure`.
    - Codex auth is closed on every `Err` path. Use `try/finally`-free sequencing on the `Result`.
  - **Container:**
    - `AppCradle.openSession: (input) => Promise<Result<RunSession, ConfigInvalid | SandboxUnavailable | SetupCommandFailed>>`
    - `openSessionRetrying` uses `retryResult`, with `shouldRetry: isTransient`, the same retries and delay, and the same `'the sandbox did not start'` warning in `onFailedAttempt`.
    - `withRunScope` and `withThrowawaySandbox` return `Promise<Result<T, JigError>>` when `use` does.
    - p-retry is no longer imported here.
  - **`init-sandbox`:** `checkInSandbox` reads a `SetupCommandFailed` `Err` instead of catching it.

- [ ] **Step 1: Write the failing tests.**
  - `sandcastle-session.spec.ts`:
    - `it('reports a sandbox that will not start as unavailable')`. The factory rejects with a plain `Error`, so `open` gives an `Err` of `SandboxUnavailable`, and codex auth is closed.
    - `it('reports a setup command that exits non-zero with its output')`. Gives a `SetupCommandFailed` `Err` whose `output` is the tail of the command output.
    - `it('asks once for a correction, then reports output it cannot parse')`. Gives an `AgentOutputInvalid` `Err` after exactly two agent calls.
  - `container.spec.ts`: `it('gives up opening the sandbox after the bounded retries with the last failure')`. `openSession` always gives `Err(SandboxUnavailable)` and `maxStepRetries` is 2, so the call returns that `Err` after 3 attempts with 3 warnings.
  - `structured-output.spec.ts`: change the existing throwing cases to `Err` assertions.
- [ ] **Step 2: Run those specs.** Expected: FAIL.
- [ ] **Step 3: Implement the port, the adapters, the fake, the container and init-sandbox.** Callers in steps use `orThrow` until Task 9.
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(sandbox): return agent and sandbox failures as values`

---

### Task 7: The RunStore port, the run lock and the metrics log

**Files:**

- Modify: `src/ports/run-store.ts`
- Modify: `src/adapters/local-store/local-run-store.ts`, `run-lock.ts`, `metrics-log.ts`, `run-artefacts.ts`
- Modify: `src/adapters/run-store/git-remote-run-store.ts`, `composite-run-store.ts`
- Modify: `src/app/run-stores.ts`, `src/app/run-jig.ts`, `src/app/run-status.ts`, `src/flow/engine.ts` (store calls only)
- Modify: the specs and the fake store

**Interfaces:**

- Consumes: `retryResult`; Task 2's errors; `orThrow`.
- Produces:
  - **`RunStore`:**
    - `load(runId): Promise<Result<RunState | undefined, RunStoreFailure>>`
    - `peek(runId)`: the same
    - `save(state): Promise<Result<void, RunStoreFailure>>`
    - `export type RunStoreFailure = RunStateConflict | RemoteUnavailable | ConfigInvalid | GitCommandFailed | LocalStateUnwritable`
  - **New error in `errors.ts`:** `LocalStateUnwritable`, `kind: 'fatal'`, fields `{ message; path: string }`.
    - It covers a failed read or write under `.jig/` (full disk, permissions).
    - The message names the path and the cause.
  - **`GitRemoteRunStore`:**
    - `remoteCall` uses `retryResult`, with `retries: REMOTE_RETRIES` and `shouldRetry: e => e._tag === 'RemoteUnavailable'`. A lease rejection gives `RunStateConflict` straight away.
    - `required()` (line 127) gives `GitCommandFailed`.
    - p-retry is no longer imported. Remove it from `package.json` in Task 9, when the engine drops it.
  - **Other stores:**
    - `CompositeRunStore` returns the first `Err` from any store.
    - `ModuleRunStore` wraps a custom module's calls with `Result.tryPromise`. A module's throw becomes a `ConfigInvalid` (`Run store "<name>" failed: …`), because it is the operator's code.
    - `openRunStore(...)`: `Promise<Result<RunStore, ConfigInvalid>>`
  - **Lock, metrics log, artefacts:**
    - `lockRun(repoRoot, runId): Promise<Result<() => Promise<void>, RunInProgress | ConfigInvalid>>`. Any other lockfile failure gives `LocalStateUnwritable`.
    - `MetricsLog.readAll()` and `summary()` return `Result<…, MetricsLogCorrupt>`. `append` stays `void`: an observer's write failure is the observer guard's to handle.
    - `RunArtefacts.write(...)`: `Promise<Result<void, LocalStateUnwritable>>`.

- [ ] **Step 1: Write the failing tests.**
  - `git-remote-run-store.spec.ts` (real temp repos):
    - `it('blocks rather than retries when the remote copy moved')`: gives a `RunStateConflict` `Err` after one push.
    - `it('retries an unreachable remote, then reports it unavailable')`: point the remote at a missing path; gives a `RemoteUnavailable` `Err`.
  - `run-lock.spec.ts`: `it('refuses a second process on the same run')`: the second `lockRun` gives a `RunInProgress` `Err`.
  - `metrics-log.spec.ts`: change the corrupt-line test to an `Err` of `MetricsLogCorrupt`.
  - `run-stores.spec.ts`: `it('reports a store module that throws as the operator's config')`: gives a `ConfigInvalid` `Err` naming the module.
- [ ] **Step 2: Run those specs.** Expected: FAIL.
- [ ] **Step 3: Implement the port, the adapters, the fake and the callers.** The engine calls `orThrow(await store.save(...))` until Task 9.
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(state): return run store failures as values`

---

### Task 8: The SandboxImages port and image building

**Files:**

- Modify: `src/ports/sandbox-images.ts`
- Modify: `src/adapters/sandbox-image/docker-images.ts`, `image-recipe.ts`, `latest-agent-versions.ts`
- Modify: `src/app/sandbox-image.ts`, `src/app/init-sandbox.ts`
- Modify: the specs and the fake images

**Interfaces:**

- Consumes: Task 2's errors; `orThrow`.
- Produces:
  - **New error in `errors.ts`:** `ImageBuildFailed`, `kind: 'fatal'`, fields `{ message; output: string }`. It replaces `throw new Error('Building … failed')`.
  - **`SandboxImages`:**
    - `labels(tag): Promise<Result<Record<string, string> | undefined, ImageBuildFailed>>`. A docker CLI failure here is `ImageBuildFailed` with a message saying docker could not be queried.
    - `build(spec): Promise<Result<void, ImageBuildFailed>>`
  - **Image recipe:**
    - `withToolchain(dockerfile, toolchain): Result<string, ConfigInvalid>`
    - `latestAgentVersions` keeps its `.catch(() => undefined)`: a registry lookup that fails means "unknown", on purpose.
  - **App:**
    - `ensureSandboxImage(d, options): Promise<Result<string, ConfigInvalid | ImageBuildFailed>>`
    - `initSandbox(app, options): Promise<Result<InitResult, JigError>>`

- [ ] **Step 1: Write the failing tests.**
  - `sandbox-image.spec.ts`:
    - `it('asks for jig init when the repository has no sandbox Dockerfile')`: gives a `ConfigInvalid` `Err`, and `build` is never called.
    - `it('reports a failed build with its output')`: the fake `build` gives `Err(ImageBuildFailed)`, so `ensureSandboxImage` returns it.
  - `image-recipe.spec.ts`: change the "no toolchain section" case to an `Err`.
- [ ] **Step 2: Run those specs.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `refactor(sandbox): return image build failures as values`

---

### Task 9: Steps and the engine

**Files:**

- Modify: `src/flow/define-flow.ts`, `src/flow/engine.ts`
- Modify: `src/steps/planning.ts`, `slice.ts`, `finishing.ts`, `pull-request-description.ts`
- Modify: their specs
- Modify: `package.json` (remove `p-retry`)

**Interfaces:**

- Consumes: every port's `Result` signature (Tasks 5–8); `retryResult`.
- Produces:
  - **Step contract:** `RunStep<P>` and `SliceStep` return `Promise<Result<Outcome, JigError>>`.
    - Steps compose with `Result.gen` and `Result.await`, and contain no `orThrow`.
    - `sliceThePlan`'s duplicate-id check returns `Err(AgentOutputInvalid)`.
    - `fillTemplate` (best-effort describer) turns a non-`fatal` `Err` into `undefined` and passes a `fatal` one on.
  - **`runEngine(flow, initial, deps)`:** returns `Promise<Result<EngineResult, JigError>>`.
  - **`Engine.attempt`:** uses `retryResult(() => this.timed(...), { retries: maxStepRetries, delayMs: retryDelayMs, shouldRetry: isTransient, onFailedAttempt })`.
    - `onFailedAttempt` publishes `stepRetried` only when the error is transient and `retriesLeft > 0`, exactly as today.
    - After the retries, a `retry` or `block` `Err` blocks the run, and a `fatal` `Err` is returned as-is.
  - **`timed`:** publishes `stepFailed` on an `Err` result, with no `catch`.
  - **`run`:**
    - publishes `runFailed` and returns the `Err` when it is `fatal`
    - publishes `runFailed` when a bug is thrown, then re-raises it with `panic(messageOf(error), error)`
    - store `Err`s from `save` are `fatal` for the invocation, as their throws are today
  - **Dependencies:** p-retry is gone from `package.json` and the lockfile.

- [ ] **Step 1: Write the failing tests.**
  - `engine.spec.ts`. Convert the existing failure-policy tests to steps that return `Err`s. Then:
    - `it('retries a transient failure, then blocks the run with its reason')`: a step always gives `Err(AgentRunFailed)` and `maxStepRetries` is 2, so the result is `Ok` with `status: 'blocked'`, `stepRetried` is published 2 times, and `stepFailed` 3 times.
    - `it('blocks straight away on a failure that needs a person')`: `Err(MergeFailed)` is called once and gives `status: 'blocked'`.
    - `it('ends the invocation on a fatal failure and says so')`: `Err(ConfigInvalid)` makes `runEngine` return that `Err`, and `runFailed` is published once.
    - `it('reports a bug in a step as a failed run and lets it through')`: a step that throws makes `runEngine` reject with a `Panic`, and `runFailed` is published.
  - `planning.spec.ts`: `it('rejects a slice plan that repeats an id')` gives an `AgentOutputInvalid` `Err`.
  - `finishing.spec.ts`: `it('falls back to its own description when the describer fails')`. The fake agent gives `Err(AgentRunFailed)` and the outcome is `described`.
- [ ] **Step 2: Run those specs.** Expected: FAIL.
- [ ] **Step 3: Implement the flow types, the steps and the engine.** Remove p-retry with `npm uninstall p-retry`.
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test && grep -rn "p-retry" src package.json`. Expected: all pass, and grep finds nothing.
- [ ] **Step 5: Commit.** `refactor(flow): let steps and the engine return failures as values`

---

### Task 10: App, CLI and the top-level handler

**Files:**

- Modify: `src/app/run-jig.ts`, `src/app/run-status.ts`
- Modify: `src/cli/with-error-handling.ts`, `src/cli/with-input.ts`, `src/cli/with-app.ts`, `src/cli/commands/*.ts`
- Modify: `src/observers/run-events.ts`, `src/app/container.ts` (`observedEvents`)
- Modify: their specs

**Interfaces:**

- Consumes: everything above.
- Produces:
  - **App:**
    - `runJig(app, input): Promise<Result<RunReport, JigError>>`
    - `readRunStatus(app, runId): Promise<Result<RunStatus, JigError>>`
    - `runJig` releases the lock on every path, `Err` included.
  - **`CommandInputInvalid`:** moves to `errors.ts` as a `TaggedError` with `kind: 'fatal'`. `withInput(schema, run)` runs `run: (input) => Promise<Result<void, JigError>>` and returns its `Err`, or `Err(CommandInputInvalid)`.
  - **`withErrorHandling(fn, output?)`:** wraps `fn: (...args) => Promise<Result<void, JigError>>`.
    - **An `Err`:** `output.printError(error.message)`, exit code 1. No stack.
    - **Anything thrown** (a `Panic` or an unwrapped third-party throw): `output.printError(...)`. The first line is `jig hit an internal error — this is a bug in jig, not in your setup. Please report it with the details below.` It is followed by the error's `stack` (or `messageOf(error)` when there is none), and the exit code is 1.
    - **`FailureOutput`:** unchanged.
  - **Observer guard:** `observe(...)` still passes an ordinary observer throw to `onObserverError`, but re-raises a `Panic` with `panic(messageOf(error), error)`.
  - **Transitional code removed:** no command calls `orThrow` any more.

- [ ] **Step 1: Write the failing tests.**
  - `with-error-handling.spec.ts`:
    - `it('prints an expected failure as its message alone')`: `fn` gives `Err(new ConfigInvalid({ message }))`, so `printError` gets exactly `message` and the exit code is 1.
    - `it('reports a thrown error as a bug in jig with its stack')`: `fn` throws `new Error(m)`, so the printed text starts with `jig hit an internal error — this is a bug in jig` and contains `m` and `at `; the exit code is 1.
  - `with-input.spec.ts`: the invalid-input test asserts an `Err` of `CommandInputInvalid`.
  - `run-events.spec.ts`:
    - `it('keeps the run going when an observer fails')`: an observer throws a plain `Error`, so `onObserverError` is called, the next observer still hears the event, and `publish` does not throw.
    - `it('lets a bug in an observer through')`: an observer calls `panic(...)`, so `publish` throws a `Panic`.
  - `run-jig.spec.ts`: `it('releases the run lock when the run fails')`. Resuming an unknown id gives `Err(RunRequestInvalid)`, and a second `lockRun` on the same id succeeds.
- [ ] **Step 2: Run those specs.** Expected: FAIL.
- [ ] **Step 3: Implement.** Delete every remaining `orThrow` call outside `errors.ts`.
- [ ] **Step 4: Verify.** Run `npm run lint && npm run typecheck && npm test && grep -rn "orThrow(" src --include=*.ts | grep -v "errors.ts"`. Expected: all pass, and grep finds nothing.
- [ ] **Step 5: Commit.** `refactor(cli): print expected failures plainly and report bugs as bugs`

---

### Task 11: Enforcement and the house rule

**Files:**

- Create: `scripts/eslint-rules/no-ignored-result.ts`, `scripts/eslint-rules/no-ignored-result.spec.ts`
- Create: `.claude/instructions/errors-as-values.md`
- Modify: `eslint.config.js`, `src/domain/errors.ts` (delete `orThrow`), `.claude/instructions/testing-conventions.md`, `CLAUDE.md`, `package.json` (add `@typescript-eslint/rule-tester` dev dependency if the spec needs it)

**Interfaces:**

- Produces:
  - **The rule.** `noIgnoredResult` is a type-aware rule with message id `ignored` and the text `A Result is dropped: handle its failure or return it.`
    - It reports an `ExpressionStatement` whose expression's type, or awaited type, includes better-result's `Ok` or `Err`, matched by symbol name. The spike's logic is in the spec, under Enforcement.
    - It is registered as `jig/no-ignored-result`.
  - **`eslint.config.js`, for non-spec `src/**/*.ts`:**
    - `parserOptions.projectService: true`
    - `@typescript-eslint/no-floating-promises: 'error'`
    - `jig/no-ignored-result: 'error'`
    - a `{ selector: 'ThrowStatement', message: 'jig does not throw: return an Err, or panic() for a bug.' }` entry appended to every `no-restricted-syntax` list that applies to non-spec `src/` files. A later block replaces the rule's whole list, so the CLI block needs it too.

- [x] **Step 1: Write the failing tests** in `no-ignored-result.spec.ts`, using `RuleTester` with `projectService.allowDefaultProject`:
  - **valid:**
    - `return parse(x);`
    - `const r = parse(x);`
    - `parse(x).match({ ok: f, err: g });` (this one returns non-Result)
    - `await save();`, where `save` returns `Promise<void>`
  - **invalid:**
    - `parse(x);`, where it returns `Result<number, E>`
    - `await load(x);`, where it returns `Promise<Result<…>>`
- [x] **Step 2: Verify the inherited lint-rule tests.** The rule and initial tests were already in flight; the completed suite passes, including the added regression cases.
- [x] **Step 3: Implement the rule and wire up all four lint changes.** Delete `orThrow`.
- [x] **Step 4: Run `npm run lint`.** Expected: PASS. Fix any violation it finds in the code: the fix is never a disable comment.
- [x] **Step 5: Write the house rule** in `.claude/instructions/errors-as-values.md`, in the style of the existing instructions. It covers the spec's rules:
  - an expected failure is an `Err`, a bug is a `panic`, an operator-fixable failure is never a bug
  - wrap a third-party call in the adapter that makes it
  - a `catch` may handle a third-party throw locally but never swallows a `Panic`
  - choose a narrow `E`
  - retry with `retryResult`

  Then:
  - Link it from `CLAUDE.md`'s list, with the trigger "writing or changing any code that can fail".
  - In `testing-conventions.md`, add: assert an expected failure on the returned `Err` (its class or `_tag` and the fields the code decided), never with `toThrow`, and keep `toThrow(Panic)` for bugs.

- [x] **Step 6: Verify.** Run `npm run validate -- --skip test:mutation`. Mutation testing and the comparison with `main` are deferred at the user's request on 2026-11-03.
- [x] **Step 7: Commit.** `refactor(dx): lint that jig never throws or drops a Result`. It is `refactor`, not `chore`, because deleting `orThrow` touches `src/`.
