## Parse Input at the Edge

## Description

- **Input from outside is parsed once, where it enters.** A CLI argument, an environment variable, a config file, a file a run reads back, a module a store imports, an agent's reply — each is parsed by a zod schema at the point it crosses into jig. Past that point only the parsed, typed value travels: a `RunId`, not a `string` that happens to look like one.
- **The domain owns the rule; the edge applies it.** The schema lives with the type it produces (`runIdSchema` in `src/domain/run-id.ts`). The edge calls it; it does not restate it in a parallel `parseX` helper, a regex, or a commander option.
- **Inner code takes the domain type and never re-checks it.** A function whose parameter is `RunId` trusts it. Passing a raw string to it should be a type error, not a runtime refusal — so there is no test for "rejects an invalid id" below the edge; that test belongs to the schema.
- **Don't confuse this with cohesion.** "The caller shouldn't know the callee's input" does not mean the callee should accept raw strings and parse them. The edge owns translating outside input into domain types; the callee owns the decisions made on those types. Moving a parse inward to tidy a call site is the wrong fix.
- **A CLI command declares its input with commander and parses it with one schema.** Arguments and options are declared with `.argument()` / `.option()` / `.addOption()`, with no `argParser` and no `.choices()` — those validate before the action runs, in commander's format, outside `withErrorHandling`. The action is `withInput(schema, run)` (`src/cli/with-input.ts`): every bad input is refused in one place, in one format, and `run` receives the schema's output type.
- **A rule across several inputs belongs in that command's schema.** "A request or `--id`, at least one" is a `.transform()` on the command's schema that produces the type the app takes (`{ start } | { resume }`), so the app's input cannot be empty.
- **Shared options get a shared schema and option builder, side by side.** `logFormatInputSchema` and `logFormatOption()` live together; a command's schema `.extend()`s the shared one.
- **`--help` reads the schema, not a copy.** An option with a fixed set of values sets `option.argChoices` from the schema's enum options, so help lists them without commander validating them.

## Examples

### Good

```typescript
export const runInputSchema = logFormatInputSchema
  .extend({ request: z.string().optional(), id: runIdSchema.optional() })
  .transform(({ request, id, logFormat }, context) => {
    const run = runToDo(request, id);
    if (run) return { run, logFormat };
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Pass a request file to start a run, or --id to resume one.',
    });
    return z.NEVER;
  });

program
  .command('run')
  .argument('[request]', 'markdown file describing what to build')
  .option('--id <id>', 'run id: resumes that run if it exists, otherwise names the new one')
  .addOption(logFormatOption())
  .action(
    withErrorHandling(
      withInput(runInputSchema, async ({ run, logFormat }) => {
        /* … */
      }),
    ),
  );

export async function runJig(app: AwilixContainer<AppCradle>, input: RunJigInput) {
  /* RunId inside */
}
```

### Bad

```typescript
.option('--id <id>', 'run id', (raw) => parseRunId(raw))
.addOption(new Option('--log-format <format>').choices(['pretty', 'json']))
.action(async (request: string | undefined, options: { id?: string; logFormat: LogFormat }) => {
  await runJig(app, { request, id: options.id });
});

export async function runJig(app: AwilixContainer<AppCradle>, { request, id }: { request?: string; id?: string }) {
  const runId = id === undefined ? undefined : parseRunId(id);
  /* … */
}
```
