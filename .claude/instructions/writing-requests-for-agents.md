## Writing Requests for Agents

Applies to three kinds of text: a request file passed to `jig run`, a GitHub issue that a workflow
turns into one, and the prompts jig itself sends to its agents (`src/prompts/`).

## Description

- **The text is the agent's entire input.** jig builds the planner's prompt from the request file alone; a workflow that runs jig on an issue typically passes `gh issue view --json title,body` — title plus body, nothing else. No comments, no linked issues, no conversation. Whatever is missing from the text is missing from the run. The same holds for each prompt jig sends: an agent sees that prompt, the repository, and nothing from earlier steps unless the prompt carries it.
- **Every request is self-contained.** Never "see #3", "as discussed", "same as the last one", or a number standing in for a description. Say so explicitly in the opening line — _"Treat this request as self-contained; don't assume access to #3"_ — so an agent that notices the reference does not go looking for it.
- **`What` and `Why` first, in plain words.** A product description for a human — no paths, code or technical terms. The technical sections follow them.
- **Open with orientation, then narrow.** A few lines on what this part of the repo is and where the relevant code lives, _then_ the concrete target. An agent that starts cold needs to be told the layering (`domain` → `flow`/`steps` → `ports` → `adapters`), that specs sit beside the code, and which unit owns the rule it is about to change.
- **Name the target by path, with the numbers that make it the target.** `src/flow/engine.ts` — mutation score 71.2, 14 surviving mutants. Not "the engine". Paths are greppable and counts are checkable; adjectives are neither.
- **Say what _decides_ something, not what to type.** Quote the actual expression the work is about (`slice.reviewCycles >= reviewCycleCap ? 'stuck' : 'pending'`) and what must hold afterwards. The agent writes the code; the request pins the behaviour.
- **Include the verify command, verbatim and runnable.** The exact invocation, from the exact directory, with the real flags. If a flag has a trap in it — a CLI `--mutate` replaces the config's `mutate` array, spec exclusions included — the request says so, because the agent will not find out until the run is already wrong.
- **Carry the gotchas forward into every request that can trip on them.** Decisions that look like mistakes get undone by an agent trying to be helpful. Each request that touches them repeats them under a _don't undo these_ heading, with the reason. Repetition across requests is correct here: they are read in isolation.
- **End with a checkable "Done when".** Commands that pass, counts that reached zero, a grep that finds nothing. Not "tests are better".
- **One request, one PR.** If the text cannot be satisfied in a single reviewable change, it is an epic and needs splitting.
- **Split an epic so that two requests never touch the same file.** Carve by file or by area, not by theme cutting across files — parallel runs on one file collide. When two requests genuinely must touch the same file, say which lands first and that the second works on top of it, in both.
- **The epic keeps the tracking table; the children carry the context.** A table of sub-requests with counts, the baseline, and a `Done when` that closes once the children do. Nothing in the epic is load-bearing for a child.
- **Say when a task is allowed to delete instead of build.** An agent asked to make a check pass will make it pass. If deleting dead code is the better answer, the request has to grant that explicitly, and ask for it to be called out in the PR.

## Examples

### Good

````markdown
One slice of the mutation-testing cleanup tracked in #3. **Treat this request as
self-contained** — everything needed is below; don't assume access to #3 or its siblings.

## What

When a slice keeps getting rejected, the run stops and asks for a person instead of looping.

## Why

The tests let a broken version of that rule through unnoticed.

## Context — read this first

jig is a Node CLI tested with Vitest. Specs sit beside the code they cover —
`engine.ts` → `engine.spec.ts`. Pipeline code receives its ports (`AgentSession`, `RunStore`)
as arguments; specs pass fakes, never `vi.mock`.

## Target

`src/flow/engine.ts` — score 71.2, **14 surviving mutants**, 0 no-coverage.

## What survived here, and what the tests must pin

- **the review cap.** `slice.reviewCycles >= reviewCycleCap ? 'stuck' : 'pending'` — both the
  `>=` boundary and the branch survived. A slice at `cap - 1` cycles goes back to `pending`;
  at `cap` it becomes `stuck`.

## How to work

```sh
npx stryker run --mutate "src/flow/engine.ts"
```

A survivor can legitimately mean dead code: prefer deleting it over a vacuous test, and say
so in the PR.

## Done when

- [ ] the run above reports 0 survived, 0 no-coverage — or each exception is named in the PR
      with why it is not worth killing
- [ ] `npm test`, `npm run lint`, `npm run format:check` pass from the repo root
````

### Bad

```markdown
Sub-task of #3.

Fix the transitions mutants — see the table in the parent issue for the counts, and follow the
same approach we used for the engine.

Make sure tests pass.
```

Nothing here survives the trip: the parent issue is not in the prompt, "the same approach" is
not in the prompt, and "make sure tests pass" is already true of the suite that let those
mutants live.
