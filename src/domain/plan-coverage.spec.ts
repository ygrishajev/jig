import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aPlannedSlice, implementingPlanSteps } from '../../tests/support/builders.js';
import { PlanNotCovered } from './errors.js';
import { checkPlanCoverage } from './plan-coverage.js';

describe('checkPlanCoverage', () => {
  it('accepts slices whose references together cover every plan step', () => {
    const { plan } = setup({ steps: [1, 2, 3] });
    const slices = [1, 2, 3].map((step) => aSliceClaiming(implementingPlanSteps(step)));

    expect(checkPlanCoverage(plan, slices).isOk()).toBe(true);
  });

  it('accepts one slice claiming every step and slices sharing a step', () => {
    const { plan } = setup({ steps: [1, 2, 3] });
    const whole = aSliceClaiming(`Implements plan steps 1-3. ${faker.lorem.paragraph()}`);
    const shared = aSliceClaiming(implementingPlanSteps(1));

    expect(checkPlanCoverage(plan, [whole, shared]).isOk()).toBe(true);
  });

  it('accepts the list and range forms of a reference', () => {
    const { plan } = setup({ steps: [1, 2, 3, 4, 5] });
    const slices = [
      aSliceClaiming(`Implements plan steps 2, 4 and 5. ${faker.lorem.paragraph()}`),
      aSliceClaiming(`Implements plan steps 1-3. ${faker.lorem.paragraph()}`),
      aSliceClaiming(`Implements plan steps 1, 2, and 3. ${faker.lorem.paragraph()}`),
      aSliceClaiming(`Implements plan steps 1 and 2. ${faker.lorem.paragraph()}`),
      aSliceClaiming(`Implements plan steps 2. ${faker.lorem.paragraph()}`),
    ];

    expect(checkPlanCoverage(plan, slices).isOk()).toBe(true);
  });

  it('accepts a reference ended by any punctuation before prose that may span lines', () => {
    const { plan } = setup({ steps: [1, 2, 3, 4] });
    const slices = [
      aSliceClaiming(`Implements plan step 1. ${faker.lorem.paragraph()}`),
      aSliceClaiming(`Implements plan step 2: ${faker.lorem.paragraph()}`),
      aSliceClaiming(`Implements plan step 3 — ${faker.lorem.paragraph()}`),
      aSliceClaiming(
        `Implements plan step 4. ${faker.lorem.paragraph()}\n\n${faker.lorem.paragraph()}`,
      ),
    ];

    expect(checkPlanCoverage(plan, slices).isOk()).toBe(true);
  });

  it('recognizes the specified step headings whatever delimiter or line ending they use', () => {
    const plan = [
      `## Step 1 — ${faker.lorem.sentence()}`,
      `## step 2: ${faker.lorem.sentence()}`,
    ].join('\r\n');
    const slices = [1, 2].map((step) => aSliceClaiming(implementingPlanSteps(step)));

    expect(checkPlanCoverage(plan, slices).isOk()).toBe(true);
  });

  it('reports no step headings when the plan marks its step with another heading level', () => {
    const plan = `# Step 1 — ${faker.lorem.sentence()}`;
    const slice = aSliceClaiming(implementingPlanSteps(1));

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain('no step headings');
  });

  it('gives other heading levels no coverage requirement', () => {
    const plan = [
      `## Step 1 — ${faker.lorem.sentence()}`,
      `### Step 2 — ${faker.lorem.sentence()}`,
      `#### Step 3 - ${faker.lorem.sentence()}`,
    ].join('\n');
    const slices = [aSliceClaiming(implementingPlanSteps(1))];

    expect(checkPlanCoverage(plan, slices).isOk()).toBe(true);
  });

  it('does not read the step number out of a heading token that runs on past it', () => {
    const plan = `## Step 1abc — ${faker.lorem.sentence()}`;
    const slice = aSliceClaiming(implementingPlanSteps(1));

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain('no step headings');
  });

  it('rejects a plan step no slice implements', () => {
    const { plan } = setup({ steps: [1, 2] });
    const slices = [aSliceClaiming(implementingPlanSteps(1))];

    const result = checkPlanCoverage(plan, slices);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain('plan step 2');
  });

  it('rejects a slice claiming a step the plan does not have', () => {
    const { plan } = setup({ steps: [1, 2] });
    const slice = aSliceClaiming(implementingPlanSteps(9));

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain('plan step 9');
  });

  it('treats a claim of step zero as a step the plan does not have', () => {
    const { plan } = setup({ steps: [1] });
    const slice = aSliceClaiming('Implements plan step 0. ' + faker.lorem.paragraph());

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain('plan step 0');
  });

  it('rejects a slice description without an Implements reference', () => {
    const { plan } = setup();
    const slice = aPlannedSlice();

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain(slice.id);
  });

  it('rejects malformed references and ranges', () => {
    const { plan } = setup({ steps: [1, 2, 3] });
    const malformed = [
      `Implements plan step 3 ${faker.lorem.sentence()}`,
      `Implements plan step ${faker.word.words(2)}. ${faker.lorem.sentence()}`,
      `Implements plan steps 3-1. ${faker.lorem.paragraph()}`,
      `Implements plan steps 1-100000. ${faker.lorem.paragraph()}`,
    ];
    const results = malformed.map((description) =>
      checkPlanCoverage(plan, [aPlannedSlice({ description })]),
    );

    expect(results.every((result) => result.isErr())).toBe(true);
  });

  it('rejects a malformed list of steps even when its claims would cover the whole plan', () => {
    const { plan } = setup({ steps: [1] });
    const malformed = [
      `Implements plan steps and 1. ${faker.lorem.paragraph()}`,
      `Implements plan steps 1,,. ${faker.lorem.paragraph()}`,
      `Implements plan steps ,1. ${faker.lorem.paragraph()}`,
      `Implements plan steps 1 and. ${faker.lorem.paragraph()}`,
      `Implements plan steps 1, and. ${faker.lorem.paragraph()}`,
    ];
    const results = malformed.map((description) =>
      checkPlanCoverage(plan, [aSliceClaiming(description)]),
    );

    expect(results.every((result) => result.isErr())).toBe(true);
    expect(
      results.every((result) => result.isErr() && result.error.message.includes('malformed')),
    ).toBe(true);
  });

  it('rejects references whose numbers pass the largest safe integer', () => {
    const { plan } = setup({ steps: [1] });
    const beyond = `${Number.MAX_SAFE_INTEGER + 1}`;
    const malformed = [
      `Implements plan step ${beyond}. ${faker.lorem.paragraph()}`,
      `Implements plan steps ${beyond}-${beyond}. ${faker.lorem.paragraph()}`,
      `Implements plan steps 1-${beyond}. ${faker.lorem.paragraph()}`,
    ];
    const results = malformed.map((description) =>
      checkPlanCoverage(plan, [aSliceClaiming(description)]),
    );

    expect(results.every((result) => result.isErr())).toBe(true);
    expect(
      results.every((result) => result.isErr() && result.error.message.includes('malformed')),
    ).toBe(true);
  });

  it('treats a claim at the largest safe integer as a step the plan does not have', () => {
    const { plan } = setup({ steps: [1] });
    const atBoundary = `${Number.MAX_SAFE_INTEGER}`;
    const slice = aSliceClaiming(
      `Implements plan steps ${atBoundary}-${atBoundary}. ${faker.lorem.paragraph()}`,
    );

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain(atBoundary);
    expect(result.isErr() && result.error.message).toContain('which the plan does not have');
  });

  it('rejects a plan without step headings', () => {
    const slice = aSliceClaiming(implementingPlanSteps(1));

    const result = checkPlanCoverage(faker.lorem.paragraphs(), [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
  });

  it('accepts a plan whose steps are not consecutive from 1, when every step is covered', () => {
    const { plan } = setup({ steps: [2, 4] });
    const slices = [2, 4].map((step) => aSliceClaiming(implementingPlanSteps(step)));

    expect(checkPlanCoverage(plan, slices).isOk()).toBe(true);
  });

  it('rejects a plan step with more than one heading', () => {
    const plan = `${planWithSteps(1, 2)}\n## Step 2 — ${faker.lorem.sentence()}`;
    const slices = [aSliceClaiming(implementingPlanSteps(1, 2))];

    const result = checkPlanCoverage(plan, slices);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toContain('heading: 2');
  });

  it('rejects a step heading numbered below one', () => {
    const { plan } = setup({ steps: [0, 1] });
    const slices = [aSliceClaiming(implementingPlanSteps(1))];

    const result = checkPlanCoverage(plan, slices);

    expect(result.isErr() && result.error).toBeInstanceOf(PlanNotCovered);
    expect(result.isErr() && result.error.message).toMatch(/\bnot 0\b/);
  });

  it('reports every problem in one error, in the same order every time', () => {
    const { plan } = setup({ steps: [1, 3] });
    const unreferenced = aPlannedSlice();
    const unknown = aSliceClaiming(implementingPlanSteps(9));
    const first = checkPlanCoverage(plan, [unreferenced, unknown]);
    const second = checkPlanCoverage(plan, [unreferenced, unknown]);

    expect(first.isErr() && first.error).toBeInstanceOf(PlanNotCovered);
    const message = first.isErr() ? first.error.message : '';
    expect(message).toContain('plan steps 1, 3');
    expect(message).toContain(unreferenced.id);
    expect(message).toContain(unknown.id);
    expect(message).toContain('plan step 9');
    expect(second.isErr() ? second.error.message : '').toBe(message);
  });

  function setup(input: { steps?: number[] } = {}) {
    const steps = input.steps ?? [1];
    return { plan: planWithSteps(...steps), steps };
  }
});

function aSliceClaiming(description: string) {
  return aPlannedSlice({ description });
}

function planWithSteps(...steps: number[]): string {
  return steps.map((step) => `## Step ${step} — ${faker.lorem.sentence()}`).join('\n');
}
