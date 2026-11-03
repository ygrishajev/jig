## Declarations in Call Order

## Description

- **A file reads top-down, in the order its code runs.** The entry point comes first. Below it come the things it uses, in the order it uses them, each followed straight away by what it uses itself, before the entry point's next callee. This is depth-first: the reader never has to scroll back up to find a helper, and never meets a helper before the code that needs it.
- **A shared callee goes once, after its first caller.** If two functions call the same helper, it sits under whichever of them comes first in the file.
- **Several entry points keep their order.** A file that exports several unrelated functions keeps them in the order they had, and each pulls its own callees in under it.
- **Types and interfaces go at the top**, after the imports, in the order the code first uses them. A type that another type uses comes after the type that uses it. The exception is a type derived from a value (`typeof X`, `z.infer<typeof schema>`), which sits directly after that value.
- **Anything read while the module loads comes before what reads it.** A `const` whose initializer uses another constant, a schema extending another schema, a class extending another class, or a table built from other values is evaluated at import time, so what it reads has to be declared first. Otherwise it throws a `ReferenceError` (TDZ) before anything runs. Code that only runs inside a function body is read later and follows call order.
- **Statements that run code at load go last.** In `src/cli/main.ts`, `if (isMainModule) await buildCli().parseAsync(...)` stays at the bottom, below everything it reaches.
- **The same rule applies inside a class.** Fields and the constructor come first, then static factories, then the public methods in the order they had. Each private method goes after the first method that calls it.
- **Constants follow call order too.** A tuning constant such as `OUTPUT_CORRECTIONS` sits after the first function that reads it, unless something reads it at load time.

## Enforcement

`npm run lint` checks every non-spec file in `src/` with `jig/declarations-in-call-order`
(`scripts/eslint-rules/`). The rule only reports, naming the expected order. It never fixes,
because a reorder can be valid TypeScript and still throw at import, and only the tests can
catch that.

## Signals

- A helper declared above the function that calls it.
- An entry point (`registerXCommand`, the exported function a file exists for) that isn't near the top.
- A type or interface declared between functions.
- Two callees of one function separated by code that neither of them uses.

## Examples

### Good

```typescript
export function registerRunCommand(program: Command) {
  // ... withInput(runInputSchema, ...) ... nextStep(report) ...
}

export const runInputSchema = logFormatInputSchema
  .extend({ request: z.string().optional(), id: runIdSchema.optional() })
  .transform(({ request, id, logFormat }, context) => {
    const run = runToDo(request, id);
    // ...
  });

function runToDo(request: string | undefined, id: RunId | undefined) {
  // ...
}

export function nextStep(report: RunReport) {
  // ... case 'stuck': return stuckMessage(state);
}

function stuckMessage(state: RunState) {
  // ...
}
```

`runToDo` comes before `nextStep` because `runInputSchema`, which calls it, is the first thing `registerRunCommand` uses. `runInputSchema` can sit below `registerRunCommand` because it is only read when the command runs, not when the module loads.

### Bad

```typescript
function stuckMessage(state: RunState) {
  /* ... */
}

export function nextStep(report: RunReport) {
  /* ... */
}

export function registerRunCommand(program: Command) {
  /* ... */
}
```

Here the reader meets the details first and the entry point last.

```typescript
export const runInputSchema = logFormatInputSchema.extend({/* ... */});

const logFormatInputSchema = z.object({/* ... */});
```

This throws at import: `runInputSchema` reads `logFormatInputSchema` while the module loads, so `logFormatInputSchema` has to be declared first.
