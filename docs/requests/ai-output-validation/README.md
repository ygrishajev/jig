# AI output validation — tracking

Seven requests that tighten how jig checks agent output before a person sees it. Each file is a
self-contained `jig run` request; nothing here is needed to run one.

| #   | Request                                                                  | Main files                                                                                                                   | Lands after |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 01  | [Record verification and report it in the PR](01-record-verification.md) | `src/domain/slice.ts`, `src/steps/slice.ts` (verify), `src/steps/pull-request-description.ts`, `src/prompts/pull-request.ts` | —           |
| 02  | [Verify before review](02-verify-before-review.md)                       | `src/flow/run-flow.ts`, `src/steps/slice.ts`, `src/prompts/slice.ts`                                                         | 01          |
| 03  | [Flag changes to tests and checks](03-flag-protected-changes.md)         | `src/ports/workspace.ts`, `src/adapters/git/git-workspace.ts`, `src/steps/slice.ts` (review), `src/prompts/slice.ts`         | 02          |
| 04  | [Final whole-run check](04-final-run-check.md)                           | `src/flow/run-flow.ts`, `src/domain/run-state.ts`, new `src/steps/final-check.ts`                                            | 01, 02, 03  |
| 05  | [Check the slice plan against the plan steps](05-check-slice-plan.md)    | `src/steps/planning.ts`, `src/prompts/planning.ts`                                                                           | —           |
| 06  | [Warn about weak validation config](06-config-warnings.md)               | `src/config/load-config.ts`, `src/app/run-jig.ts`                                                                            | —           |
| 07  | [Review the design before slicing](07-review-design.md)                  | `src/steps/planning.ts`, `src/prompts/planning.ts`, `src/flow/`, `src/domain/`                                               | 04, 05      |

01 → 02 → 03 → 04 must run in that order (they share `src/steps/slice.ts`, `src/prompts/slice.ts`
and `src/flow/run-flow.ts`). 05 and 06 can run alongside 01–04. 07 follows 04 and 05 because it
shares planning, flow, and domain files; 06 is independent of it.

## Done when

- [ ] all seven are merged
- [ ] `npm run validate -- --skip test:mutation` passes on `main`
