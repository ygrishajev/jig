---
paths:
  - '**/*.spec.ts'
  - 'tests/**/*.ts'
---

## Testing Conventions

## Description

- **Vitest, node environment.** A spec is `*.spec.ts` beside the code it covers: `src/flow/engine.ts` → `src/flow/engine.spec.ts`. Never add new files under `tests/` except shared helpers in `tests/support/` and the live end-to-end run in `tests/e2e/`.
- **Coverage is the floor, not the goal.** `npm run test:mutation` (Stryker) is the real measure here — a spec that raises coverage without killing mutants is worse than no spec.
- **`setup` function, not `beforeEach`.** It sits at the bottom of the root `describe`, takes a single parameter with an inline type, builds the thing under test and returns it (plus whatever the tests need to read back). No shared state between tests, and no declared return type.
- **Assert an expected failure on the returned `Err`, never with `toThrow`.** Check `result.isErr()`, then its class or `_tag` and the fields the code decided, on `result.error`. Never `expect(result).toEqual(Result.err(x))`: better-result's `Err` is iterable, so that panics. `toThrow(Panic)` is kept for bugs. To read a value you do not assert on, use `unwrap` from `tests/support/unwrap.ts`.
- **Never test statics.** Do not assert that a hardcoded prompt sentence, label or log message is present. Test what the code _decides_: a transition, a branch, a computation, a parsed value, a call it made, a file or commit it produced. `expect(prompt).toContain('You are the review step')` proves nothing.
- **Name a test by the behaviour, in the third person.** `it('sends the slice back to implement with the reviewer feedback')`, not `it('should work')` or `it('handles rejection')`.

## Dependency injection over mocking

- **Never mock a module.** No `vi.mock`, no monkey-patching `process` or `fs`. A unit that needs something it cannot have in a test — an agent, docker, the clock, the network — declares it, and the spec passes a stand-in.
- **Pipeline code takes ports.** Steps and the engine receive their ports (`AgentSession`, `Workspace`, `RunStore`, `Clock`, …) as arguments; the composition root in `src/app/` is the only place that builds real adapters.
- **Every external call lives in an adapter.** A process spawn, a git command, a file write, a network request or a sandcastle call is never made from `domain/`, `flow/` or `steps/` — it sits behind a port in `adapters/`. If pipeline code needs something new from the outside world, add a method to a port (or a new port), not an import.
- **Declare the narrow port, not the library's whole type.** `AgentSession` is what the pipeline calls, not sandcastle's `Sandbox`. The real adapter implements it, and a fake or a `mock<T>()` satisfies it without a cast.
- **`mock<T>()` from `vitest-mock-extended`, never `as unknown as T`.** Override the fields the test cares about and let the rest be auto-mocked. `mock<T>()` stays in step with the real type — a renamed or added field surfaces as a type error — while an `as unknown as` double keeps compiling with stale fields. Keep `as unknown as` for a type `mock<T>()` cannot satisfy (a branded type), with a JSDoc on the helper saying why.

## Fakes over stubs

- **Fake the boundary, not the layer above it.** The agent is faked at `AgentSession` — the prompt building, output parsing and state transitions under test are the ones production runs. Git is never faked: specs that touch git run against a real temporary repository (`tests/support/temp-repo.ts`).
- **A fake agent does what a real one would.** When a step expects the agent to change files or emit structured output, the fake writes those files into the worktree or returns that output — it doesn't just return `{ success: true }`.
- **Real sandcastle and real agents stay out of the unit suite.** They belong in an explicitly opt-in integration run, never in `npm test`.

## Test data

- **Build it with shared builders** (`tests/support/builders.ts`), built with `@faker-js/faker`. Each is a destructured-parameter factory whose every field defaults to something generated:
  ```ts
  export function aSlice({
    id = sliceId(),
    title = faker.lorem.sentence(),
    description = faker.lorem.paragraph(),
    order = faker.number.int({ min: 0, max: 20 }),
    status = 'pending',
    reviewCycles = 0,
  }: Partial<Slice> = {}): Slice {
    return { id, title, description, order, status, reviewCycles };
  }
  ```
- **A spec names what it depends on, and reads back what it did not.** `expect(meta.currentSliceId).toBe(next.id)`, never a literal that happens to match a default. An assertion that only passes because of a builder default is testing the builder.
- **Random data is the point.** It is what stops a spec quietly depending on a value nobody chose. When it makes a test fail, the test was over-specified — fix the test, do not pin the builder.
- **Pin what the behaviour is about.** Ordering slices means the orders are explicit. A review cap means `reviewCycles` and the cap are explicit. Everything else stays generated.
- **Generated ids must be valid and distinct.** Slice and run ids must match `^[a-z0-9-]+$`; build them with the shared `sliceId()` / `runId()` helpers rather than raw faker.
- **Re-run the suite a few times after touching a builder.** Random data that only passes on some seeds is a real failure, not noise.

## End-to-end

- **A whole run, through the engine, against a real temporary repository and a fake agent.** Plan, implement, review, verify and merge, asserting on the run branch's commits and the saved run state — not on log output.
- **Crash and resume are part of end-to-end.** Stop a run between steps, start it again from saved state, and assert it finishes with the same commits it would have produced uninterrupted.

## Examples

### Good

```ts
describe('review step', () => {
  it('sends the slice back to implement with the reviewer feedback', async () => {
    const feedback = faker.lorem.sentence();
    const { review, slice } = setup({ verdict: { approved: false, feedback } });

    const outcome = await review(slice);

    expect(outcome).toEqual({ type: 'rejected', feedback });
  });

  function setup(input: { verdict: { approved: boolean; feedback: string } }) {
    const slice = aSlice({ status: 'in_review' });
    const session = fakeAgentSession({ output: input.verdict });
    return { slice, review: (s: Slice) => reviewSlice(s, { session }) };
  }
});

const store = mock<RunStore>({
  load: vi.fn().mockResolvedValue(aRunSnapshot({ state: 'slices' })),
});
```

### Bad

```ts
vi.mock('../adapters/sandcastle/session.js', () => ({ SandcastleSession: FakeSession }));

describe('review step', () => {
  let slice: Slice;

  beforeEach(() => {
    slice = {
      id: 's1',
      title: 'Slice',
      description: 'desc',
      order: 0,
      status: 'in_review',
      reviewCycles: 0,
    };
  });

  it('works', async () => {
    expect(buildReviewPrompt(slice)).toContain('You are the review step');
  });
});

const store = { load: vi.fn().mockResolvedValue(snapshot) } as unknown as RunStore;
```
