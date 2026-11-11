Treat this request as self-contained — everything needed is below; don't assume access to any
other issue or request.

## What

When jig's configuration leaves agent output weakly checked, jig says so at the start of every
run. Two cases: no project check command is configured, and the same agent and model both write
and review the code.

## Why

Without a check command, the only thing standing between agent code and the pull request is
another agent's opinion. A reviewer that is the same model as the author tends to share its blind
spots. Both setups are allowed, but an operator should never run them without knowing.

## Context — read this first

jig is a Node/TypeScript CLI. `jig.config.json` is parsed by a strict zod schema in
`src/config/load-config.ts`; `verifyCommand` is optional there, and each step (`planner`,
`implementer`, `reviewer`, `describer`) is `{ provider, model? }`. `claude` without a model falls
back to a default (`opus`), so two claude steps without models use the same model. A run starts
in `runJig` in `src/app/run-jig.ts`; the pino logger is `app.cradle.logger` (see
`src/app/sandbox-image.ts`, which logs `plan.warnings` with `logger.warn`). Specs sit beside the
code. House rules are in `.claude/rules/` — read `callee-owns-its-rules.md` and
`testing-conventions.md` first.

## Target behaviour

1. **The config module owns the rule.** Add `validationWarnings(config: JigConfig): string[]` in
   `src/config/load-config.ts` (or a sibling file in `src/config/`):
   - no `verifyCommand` → "No verifyCommand is set: slices are approved on the reviewer's word
     alone. Run `jig init` to have one proposed, or set it in jig.config.json."
   - `implementer` and `reviewer` resolve to the same provider and model (treat a missing claude
     model as its default) → "The implementer and reviewer are the same model (<provider>/<model>);
     a different reviewer catches more."
2. **A run logs them** with `logger.warn` once, when a run starts or resumes, before the sandbox
   is built. They never stop the run.
3. **No new config keys** and no change to defaults — `verifyCommand` stays optional.

## Don't undo these

- The config schema stays `.strict()`: unknown keys are errors.
- Warnings are not errors: no `Result.err`, no non-zero exit.

## How to work

From the repo root:

```sh
npm run validate -- --skip test:mutation
```

Mutation testing takes 20+ minutes; skip it.

## Done when

- [ ] `src/config/load-config.spec.ts` covers: both warnings; neither; same provider with
      different models (no warning); two claude steps without models (warning)
- [ ] a spec in `src/app/` shows the warnings logged when a run starts
- [ ] `npm run validate -- --skip test:mutation` passes
