---
paths:
  - 'src/**/*.ts'
  - 'scripts/**/*.ts'
---

## The Callee Owns Its Rules

## Description

- **A rule lives in the module it is about, once.** If a caller has to know how another module works inside — which steps to take in which order, what to check first, which names it uses — that knowledge has leaked. Move it to the module that owns it and give the caller one call.
- **Ask for the answer, not the ingredients.** A caller that wants "this run's metrics" calls `metricsLog.summary()`; it does not read the records and run them through `summarizeMetrics` itself. A caller that wants "the documents this run left" calls `artefacts.documents(runId)`; it does not keep its own list of names and probe each one.
- **A function checks its own preconditions.** `startTelemetry` returns `undefined` when no endpoint is configured; the caller does not guard it with `telemetryEnabled`. A guard a caller must remember is a bug the next caller will write.
- **A lifecycle gets one wrapper, not an exported pair.** Open/close, acquire/release, start/stop that must happen in a fixed order become `withX(…, use)`, which runs `use` and tears down however it ends. `runJig` acquires the run's scope through `withResource` (`src/app/lifecycle.ts`), which closes the sandbox session before disposing the scope however the run ends; an exported `openRunScope` / `closeRunScope` pair would let a caller dispose alone and leave the sandbox container running.
- **Hand the caller what it needs, not your internals.** The run's `RunScope` hands `runJig` the `EngineDependencies`, not the parts it was built from — the caller never learns how the session, workspace and reporting were made.
- **The CLI calls an application operation; it never receives the wiring.** A command handler parses its input, calls an operation from the app's public entry with typed values, formats the `Result` and sets the exit code. It does not get a runtime factory or its parts, build adapters, load config, probe Git or open and close scopes. Repository checks, required stores, locking and cleanup belong to the operation, so a caller that is not the CLI gets them without repeating them.
- **The composition root only wires.** It chooses implementations, constructs them in explicit factories, attaches observers and starts the executable. Policy — retry counts, which errors are transient, resume, locking, required stores, credential consent, publication — belongs to the app, domain, config or port contract it is about, even when composition installs the implementation. So do adapter knowledge (how config becomes sandcastle options), environment meaning and file names.
- **A configurable default belongs to config; a business rule belongs to domain.** Config owns the configuration and environment schemas, their defaults, provider and model policy, presets and precedence. The default step retry count is a config default; domain owns the resolved `RunSettings` and the rules that read it, such as `reviewCapReached` comparing review cycles with the resolved cap. A genuine safety or stopping rule (`HOOK_FAILURE_CAP`) stays in domain: a numeric constant is not by itself a setting, and moving a default does not make it operator-configurable.
- **A list is defined once, and the compiler holds the rest to it.** Define it `as const`, derive the type from it, and where every member needs a value build a `Record<Member, …>` so a new member without one fails the build.
- **A single-use export is a question, not a defect.** Prompt builders used by one step, adapters wired once in the composition root and helpers exported for their spec are fine. Ask whether the one caller is doing work the callee should.

## Target and current layout

The ownership above is the target in [`docs/specs/application-boundaries.md`](../../docs/specs/application-boundaries.md). Every command follows it: `jig run`, `jig status`, `jig presets`, `jig init`, `jig build` and `jig github implement` receive `JigOperations` from `src/app/api.ts`, bound by `src/composition/main.ts`, and preparation lives in `src/app/repository-preparation.ts`. Dependency lint holds every file outside app and composition, specs included, to that entry: a CLI handler or spec that imports another app module fails `app-internals-are-private-to-app-and-composition`, and production app that imports an adapter, observer or CLI module in any form — value, type-only, re-export or dynamic — fails `app-imports-no-infrastructure`; name a port or an app type instead. `runJig` takes narrow `RunCapabilities` and owns the run's lock, store selection, start or resume and release order; the stores are built behind `RunStoreCatalog`. `withPreparedRun` (`src/app/run-operation.ts`) prepares the repository, applies the preset and releases the run's runtime for both `startOrResumeRun` and `implementGithubIssue`, which refuses its GitHub settings first and supplies only the accepted request, run id, required stores and deferred code publication. `initRepository` decides when to ask for agents, credentials and save consent through `InitInteraction`, which terminal adapters implement. Composition constructs the runtimes with explicit factories and no DI container: `runRuntimeFactory` (`src/composition/run-runtime.ts`) and `sandboxRuntimeFactory` (`src/composition/sandbox-runtime.ts`) build the adapters over the wiring in `src/composition/runtime-wiring.ts`, and attach the observers in `src/composition/observed-events.ts`. The app keeps the order: `acquireRunScope` (`src/app/run-scope.ts`) opens the run's reporting, its sandbox under `transientRetryPolicy` and its workspace from the parts composition supplies, and assembles `EngineDependencies`; `ensureSandboxImage` decides rebuilds over the `SandboxImageRecipe` port. New code follows the target; where today's layout does not allow it, extend the existing shape and say in the PR which owner the code belongs to.

## Signals

- A value computed only to be handed straight to the callee.
- Two exports with one caller that only work as a pair.
- A caller checking a condition before a call.
- A caller restating a list, name or file layout the callee owns.
- A caller reaching into another module's internals (`scope.parts.workspaceFor(…)`).
- The same predicate or expression in two modules (`error instanceof AgentRunFailed && error.kind === 'retry'`).
- A CLI handler or use case that takes a runtime factory or builds an adapter.
- Wiring code that branches on run state, error kind or operator choice.
- A default value declared in domain, or a domain rule copied into config.

## Examples

### Good

```typescript
const telemetry = await startTelemetry(environment.telemetry);
try {
  return await withRunScope(scopes, state, store, { tracer: telemetry?.tracer }, (dependencies) =>
    runEngine(runFlow, state, dependencies),
  );
} finally {
  await telemetry?.shutdown();
}

const DOCUMENTS = ['design.md', 'plan.md', 'PR_DESCRIPTION.md'] as const;
export type RunDocument = (typeof DOCUMENTS)[number];

function documentContents(
  state: RunState,
  metrics: MetricsSummary,
): Record<RunDocument, string | undefined> {
  return {
    'design.md': state.docs?.design,
    'plan.md': state.docs?.plan,
    'PR_DESCRIPTION.md': pullRequestDescription(state, metrics),
  };
}

program.command('run').action(withInput(runInputSchema, (input) => jig.run(input)));

// composition: choose implementations, build the app, hand its operations to the CLI
const program = buildProgram(createJig({ runStores, sandbox, terminal }));

// src/config: the default lives with configuration; domain reads the resolved value
const STEP_RETRIES = 2;
export function runSettingsFrom(config: JigConfig): RunSettings {
  return { reviewCycleCap: config.reviewCycleCap, maxStepRetries: STEP_RETRIES /* … */ };
}

export function reviewCapReached(slice: Slice, settings: RunSettings): boolean {
  return slice.reviewCycles >= settings.reviewCycleCap;
}
```

### Bad

```typescript
const telemetry = telemetryEnabled(environment) ? await startTelemetry(environment) : undefined;
const run = { runId: state.runId, baseBranch: state.baseBranch };
const scope = await openRunScope(parts, run, store, { tracer: telemetry?.tracer });
try {
  return await runEngine(runFlow, state, scope.parts.engineDependencies());
} finally {
  await closeRunScope(scope);
}

const DOCUMENTS: RunDocument[] = ['design.md', 'plan.md', 'PR_DESCRIPTION.md'];
const documents = DOCUMENTS.flatMap((name) => {
  const found = artefacts.documentPath(runId, name);
  return found ? [{ name, path: found }] : [];
});
const metrics = summarizeMetrics(new MetricsLog(repoRoot, runId).readAll());

// a CLI handler that loads config and builds the runtime itself
.action(withInput(runInputSchema, async (input) => {
  const runtime = runRuntimeFactory()(await loadConfig(cwd));
  return runJig(runtime.run, input);
}));

// composition deciding resume and retry policy instead of wiring
const store = (await runStore.exists(runId)) ? resumeStore(runId) : startStore(runId);
const retries = isTransient(error) ? 2 : 0;

// a configurable default declared in src/domain/settings.ts
export const MAX_STEP_RETRIES = 2;
```
