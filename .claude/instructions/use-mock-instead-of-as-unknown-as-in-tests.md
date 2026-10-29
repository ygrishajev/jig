## Use `mock<T>()` instead of `as unknown as <Type>` in tests

## Description

- Build test doubles with `mock<T>()` from `vitest-mock-extended` rather than hand-rolled object literals coerced via `as unknown as <Type>`
- `mock<T>()` stays in sync with the real type: if a field is added or renamed upstream, the mock keeps satisfying the contract automatically (or surfaces a real type error). Hand-built `as unknown as` doubles silently keep compiling with stale fields and hide contract regressions
- Override only the fields the test cares about; let `mock<T>()` provide auto-mocked fns/values for everything else
- For a `DEPENDENCIES` entry, type the double from it: `mock<typeof DEPENDENCIES>({ execa: vi.fn().mockResolvedValue(result) })`
- A fake that behaves (an agent session that writes files, a run store that remembers) is a small class implementing the port, not a `mock<T>()` — see `testing-conventions.md`, "Fakes over stubs"
- Reserve `as unknown as` for the rare case where the type is structurally incompatible (e.g. branded types) and `mock<T>()` cannot help, and say why in a JSDoc on the helper

## Examples

### Good

```typescript
import { mock } from 'vitest-mock-extended';

const store = mock<RunStore>({
  load: vi.fn().mockResolvedValue(aRunSnapshot({ state: 'slices' })),
});
```

```typescript
const dependencies = mock<typeof DEPENDENCIES>({
  execa: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '2 tests failed' }),
});
```

### Bad

```typescript
const store = {
  load: vi.fn().mockResolvedValue(snapshot),
} as unknown as RunStore;
```

```typescript
const session = {
  run: vi.fn(),
  exec: vi.fn(),
  close: vi.fn(),
  worktreePath: '/tmp/x',
} as unknown as AgentSession;
```
