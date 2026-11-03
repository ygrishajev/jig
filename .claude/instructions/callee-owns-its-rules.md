## The Callee Owns Its Rules

## Description

- **A rule lives in the module it is about, once.** If a caller has to know how another module works inside — which steps to take in which order, what to check first, which names it uses — that knowledge has leaked. Move it to the module that owns it and give the caller one call.
- **Ask for the answer, not the ingredients.** A caller that wants "this run's metrics" calls `metricsLog.summary()`; it does not read the records and run them through `summarizeMetrics` itself. A caller that wants "the documents this run left" calls `artefacts.documents(runId)`; it does not keep its own list of names and probe each one.
- **A function checks its own preconditions.** `startTelemetry` returns `undefined` when no endpoint is configured; the caller does not guard it with `telemetryEnabled`. A guard a caller must remember is a bug the next caller will write.
- **A lifecycle gets one wrapper, not an exported pair.** Open/close, acquire/release, start/stop that must happen in a fixed order become `withX(…, use)`, which runs `use` and tears down however it ends. `withRunScope` closes the sandbox session before disposing the scope; an exported `openRunScope` / `closeRunScope` let a caller dispose alone and leave the container running.
- **Hand the caller what it needs, not your internals.** `withRunScope` gives `use` the `EngineDependencies`, not the scope — the caller never learns cradle keys.
- **A list is defined once, and the compiler holds the rest to it.** Define it `as const`, derive the type from it, and where every member needs a value build a `Record<Member, …>` so a new member without one fails the build.
- **The composition root only wires.** `src/app/container.ts` decides what is built, with what, and how long it lives. Policy (retry counts, which errors are transient), adapter knowledge (how config becomes sandcastle options), environment meaning and file names belong to the module they are about.
- **A single-use export is a question, not a defect.** Prompt builders used by one step, adapters wired once in the container and helpers exported for their spec are fine. Ask whether the one caller is doing work the callee should.

## Signals

- A value computed only to be handed straight to the callee.
- Two exports with one caller that only work as a pair.
- A caller checking a condition before a call.
- A caller restating a list, name or file layout the callee owns.
- A caller reaching into another module's internals (`scope.cradle.engineDependencies`).
- The same predicate or expression in two modules (`error instanceof JigError && error.kind === 'retry'`).

## Examples

### Good

```typescript
const telemetry = await startTelemetry(app.cradle.environment);
try {
  return await withRunScope(app, state, store, { tracer: telemetry?.tracer }, (dependencies) =>
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
```

### Bad

```typescript
const telemetry = telemetryEnabled(environment) ? await startTelemetry(environment) : undefined;
const run = { runId: state.runId, baseBranch: state.baseBranch };
const scope = await openRunScope(app, run, store, { tracer: telemetry?.tracer });
try {
  return await runEngine(runFlow, state, scope.cradle.engineDependencies);
} finally {
  await closeRunScope(scope);
}

const DOCUMENTS: RunDocument[] = ['design.md', 'plan.md', 'PR_DESCRIPTION.md'];
const documents = DOCUMENTS.flatMap((name) => {
  const found = artefacts.documentPath(runId, name);
  return found ? [{ name, path: found }] : [];
});
const metrics = summarizeMetrics(new MetricsLog(repoRoot, runId).readAll());
```
