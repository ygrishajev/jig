---
paths:
  - 'src/**/*.ts'
  - 'scripts/**/*.ts'
---

## Clean Code Over Comments

## Description

- **Clarity is the default; a comment is the last resort.** Before writing any comment, make the code say it — rename to reveal intent, or extract a named function. A comment you _had_ to write is a signal the code failed to be clear: fix the code, don't annotate it.
- **No inline comments.** Never write `//` or `/* */` comments inside function bodies or tests — not even to label a section or restate a line. The only allowed comment is a `/** ... */` JSDoc block on a declaration, and only for the _why_ (a non-obvious constraint, gotcha, or tradeoff) — never the _what_.
- **Names replace comments.** Prefer a verbose, intention-revealing name over a short name plus a comment: `secondsUntilIdleTimeout`, not `t` with a `// seconds until the agent is killed`. Name functions by behavior, not by trigger: `requestChangesOnSlice`, not `onReviewFailed`. A name that needs a comment to be understood is the wrong name.
- **One name per callback.** When a callback is bound to a named `const`, the `const` carries the behavior name and the body stays an anonymous arrow — don't _also_ name the function expression, and don't name the `const` after its trigger or the parameter it feeds. Keep a named function expression only for a callback that has no binding name of its own, e.g. an inline `slices.map(function toSliceLine() {…})`.
- **Structure replaces comments.** A function that needs internal section-comments to navigate wants to be several named functions. Separate concerns at every level — orchestration vs. detail, one reason to change per unit — so each piece is small enough to need no narration. Don't over-fragment though: single-statement operations stay inline; extract only multi-line sequences that earn a name.
- **JSDoc the non-obvious.** Module-level helper functions and "magic" constants (caps, timeouts, file names, tag names) get a 1–2 line JSDoc stating what/why. Skip it when the name is already fully self-describing.
- **Existing code predates this rule.** Much of `src/` is heavily commented. Don't copy that density into new code; when you rewrite a unit, turn the comments that carry a real _why_ into JSDoc on the declaration and delete the rest.

## Examples

### Good

```typescript
/** The review loop gives up on a slice after this many rejections and asks for a human. */
const DEFAULT_REVIEW_CYCLE_CAP = 3;

function hasReachedReviewCap(slice: Slice, cap: number) {
  return slice.reviewCycles >= cap;
}
```

```typescript
async function implementSlice(session: AgentSession, slice: Slice) {
  const result = await session.run({ prompt: buildImplementPrompt(slice), agent: implementer });
  return result.success ? sliceImplemented(slice) : implementFailed(slice, result.output);
}
```

### Bad

```typescript
// the review loop stops after 3 rounds
const c = 3;

function check(slice: Slice) {
  // has the slice been reviewed too many times?
  return slice.reviewCycles >= c; // compare against the cap
}
```

```typescript
async function implementSlice(session: AgentSession, slice: Slice) {
  // 1. build the prompt
  const prompt = buildImplementPrompt(slice);

  // 2. run the agent
  const result = await session.run({ prompt, agent: implementer });

  // 3. figure out what happened
  if (result.success) {
    return sliceImplemented(slice);
  }
  return implementFailed(slice, result.output);
}
```

```typescript
const onReviewFailed = (slice: Slice) =>
  function requestChangesOnSlice() {
    /* … */
  };
```
