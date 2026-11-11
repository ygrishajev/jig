Treat this request as self-contained — everything needed is below; don't assume access to any
other issue, request, or external skill.

## What

Before breaking the work into slices, have a separate reviewer check whether the proposed design
and implementation plan satisfy the request and hold up against the repository. Give the planner
one opportunity to address consequential findings, then review the result again. Unresolved
issues stop the run before code is written, with a report explaining what needs attention.

## Why

A well-formed plan can still miss a requirement, contradict the existing system, or rely on an
unsupported assumption. Checking that every planned step has a slice cannot detect those failures.
An independent review should challenge consequential decisions without becoming a style debate or
an unlimited planning loop.

## Context — read this first

jig is a Node/TypeScript CLI. Domain types and schemas live in `src/domain/`, orchestration in
`src/flow/` and `src/steps/`, ports in `src/ports/`, and implementations in `src/adapters/`.
Specs sit beside their code; pipeline specs use fake ports rather than module mocks.

`src/flow/run-flow.ts` currently goes from `writeDesign` to `sliceThePlan`, then
`applyDesignGate`. Planning steps are in `src/steps/planning.ts`, prompts in
`src/prompts/planning.ts`. `writeDesign` returns `state.docs.design` and `state.docs.plan`;
the latter uses `## Step N — <title>` headings. Agent calls use
`ports.agent.runForOutput({ role, prompt, schema })`. Use the existing `reviewer` role for the
review and `planner` for revision: separate invocations, even when configured to use the same
agent and model.

Run state, outcomes, and transitions are defined in `src/domain/run-state.ts`,
`src/domain/outcome.ts`, and `src/flow/`. `src/flow/engine.ts` persists progress and records
expected failures as blocked runs. Follow the existing artifact and status mechanisms rather
than adding a second state store. House rules are in `.claude/rules/`; read the applicable rules,
including errors-as-values, parse-input-at-the-edge, callee-owns-its-rules, and testing-conventions.
Read the newest spec in `docs/superpowers/specs/` before changing the flow or persisted state.

Land this after the slice-coverage check: that change checks that slice descriptions reference
existing plan steps and cover every step, with one correction attempt. Preserve that behavior.
This request also shares flow and domain files with the final whole-run check; land after that
change too. The final whole-run check reviews delivered work after implementation and can request
one repair; keep it intact.

## Target behavior

1. **Review before slicing.** Pass the original request, repository context, feature plan, and
   both design documents to a fresh reviewer invocation. Allow repository exploration inside the
   existing sandbox. The reviewer returns structured output, not repository edits.
2. **Filter for consequential decisions.** Raise a finding only when a wrong or missing decision
   could materially change required behavior, violate a repository constraint, or cause costly
   rework. Cover missing requirements as well as incorrect choices. Exclude stylistic preferences,
   speculative future needs, and improvements outside the request.
3. **Require actionable evidence.** Each finding has a stable identifier, the affected requirement
   or decision, a concrete failure scenario, evidence from the request or repository, and a
   recommended correction. Distinguish a technical correction from a decision requiring operator
   input. Unknown facts must be investigated where possible; remaining uncertainty is explicit,
   never invented evidence. Validate the structured response with a domain-owned zod schema at
   the agent boundary. Derive approval from an empty findings list so verdict and findings cannot
   contradict each other.
4. **One revision and one re-review.** With no findings, continue directly to slicing. Otherwise
   give the planner the complete review and original inputs. It returns revised design and plan
   documents plus a disposition for each finding: addressed, or disputed with evidence. A
   recommendation is not automatically accepted. The reviewer then receives the revised documents,
   original request and context, prior findings, and planner dispositions. It checks whether the
   findings are resolved and whether the revision introduces another consequential problem.
   Only an empty findings list allows slicing. There is at most one planner revision and two
   reviews in this cycle; this cap is independent of the slice review cap.
5. **Respect user intent.** Agents may settle technical details within the request. They must not
   silently broaden scope, override an explicit requirement, or invent a product preference to
   settle conflicting requirements. An explicit, bounded assumption is acceptable only when it
   stays within the request and does not leave a consequential decision unresolved. Findings that
   still require operator input after re-review block the run in either gate mode.
6. **Persist the evidence and budget.** Save review output, revised documents, dispositions, and
   cycle progress through existing run state and stores. Resume uses persisted progress rather
   than restarting an already completed review or granting another revision after the cap. Expose
   a readable review report alongside the existing planning artifacts, including when blocked,
   and include outstanding findings in the blocked reason/status output. New agent calls use the
   existing metrics machinery. Existing saved runs must remain loadable: completed runs stay
   completed, and a run already past planning must not unexpectedly restart planning.
7. **Preserve the checkpoint contract.** Successful review leads to slicing, its coverage check,
   and then the existing `designGate`. `auto` continues; `checkpoint` pauses with the reviewed
   documents and report available. Resuming that checkpoint proceeds with the persisted reviewed
   plan and slices. This change does not introduce editable-file feedback or import edits to
   exported planning artifacts; document that boundary in the README.

For example, a request requires retries to preserve idempotency but the plan does not explain how
duplicate writes are prevented. The reviewer identifies the duplicate-write scenario and relevant
request/code evidence; the planner adds a supported solution or explains an existing guarantee;
the reviewer verifies it before slicing. Renaming a helper according to personal preference must
not trigger this loop.

## Don't undo these

- All agent calls run unattended only inside the sandbox. Review and revision return data; they
  must not modify target repository files, create commits, or import commits to the host.
- Keep `designGate: auto` as the default and reuse the existing agent roles; no new configuration
  switch or agent role is needed.
- Slice coverage remains a separate deterministic check after design review. Do not replace it
  with an agent's opinion.
- There is no minimum slice count. Preserve the plan's step-heading format for the coverage check.
- Expected failures are `Result` errors, not throws. An unresolved design is an operator-facing
  blocked result, not a panic or an implementation slice marked stuck.
- Do not install the external spec-grilling skills or add their decision graph, two-file review,
  migration, ADR, glossary, or cleanup machinery. This is one bounded review stage.

## How to work

From the repository root:

```sh
npm run validate -- --skip test:mutation
```

Skip mutation testing; it takes 20+ minutes. Use scripted agent replies and fake ports for flow
tests; verification must not require Docker, credentials, or paid agent calls.

## Done when

- [ ] an approved first review reaches slicing without a planner revision
- [ ] findings reach the planner, and a successful re-review slices the revised plan
- [ ] an evidence-backed planner dispute can be accepted by the reviewer
- [ ] outstanding or newly introduced findings after re-review block before slicing/implementation
- [ ] unresolved operator decisions block in both `auto` and `checkpoint` modes
- [ ] invalid structured replies fail at the boundary with an operator-facing error
- [ ] resume tests demonstrate persisted progress, no extra revision budget, and compatibility
      with saved runs from before this change
- [ ] both gate modes retain their existing successful behavior; checkpoint resume uses the
      reviewed documents and slices
- [ ] the report and blocked explanation expose unresolved findings through existing artifacts
      and status, and new calls contribute to existing metrics
- [ ] prompt specs pin the consequential-finding filter, evidence requirements, supplied inputs,
      and prohibition on repository edits without asserting entire prompt strings
- [ ] README describes the review stage, cap, blocked behavior, and checkpoint feedback boundary
- [ ] `npm run validate -- --skip test:mutation` passes
