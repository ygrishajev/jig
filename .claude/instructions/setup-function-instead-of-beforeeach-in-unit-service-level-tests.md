---
description:
globs: **/*.spec.ts,**/*.test.ts
alwaysApply: false
---

## Use setup function instead of beforeEach

## Description

- Use `setup` function instead of `beforeEach`
- `setup` function must be at the bottom of the root `describe` block
- `setup` function creates an object under test and returns it
- `setup` function should accept a single parameter with inline type definition
- Don't use shared state in `setup` function
- Don't specify return type of `setup` function

## Examples

### Good

```typescript
describe('transition', () => {
  it('marks a slice stuck once the review cap is reached', () => {
    const { slice, next } = setup({ reviewCycles: 2, cap: 3 });
    expect(next(slice, { type: 'rejected', feedback: faker.lorem.sentence() }).status).toBe(
      'stuck',
    );
  });

  function setup(input: { reviewCycles: number; cap: number }) {
    const slice = aSlice({ status: 'in_review', reviewCycles: input.reviewCycles });
    const next = (s: Slice, outcome: ReviewOutcome) =>
      transitionSlice(s, outcome, { reviewCycleCap: input.cap });
    return { slice, next };
  }
});
```

### Bad

```typescript
describe('transition', () => {
  let slice: Slice;

  beforeEach(() => {
    slice = aSlice({ status: 'in_review', reviewCycles: 2 });
  });

  it('marks a slice stuck once the review cap is reached', () => {
    expect(
      transitionSlice(slice, { type: 'rejected', feedback: 'no' }, { reviewCycleCap: 3 }).status,
    ).toBe('stuck');
  });
});
```

## References

- https://github.com/akash-network/console/discussions/910
