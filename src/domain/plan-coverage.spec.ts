import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aPlannedSlice, implementingPlanSteps } from '../../tests/support/builders.js';
import { AgentOutputInvalid } from './errors.js';
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

  it('recognizes step headings whatever delimiter, heading depth or line ending they use', () => {
    const plan = [
      `# Step 1 — ${faker.lorem.sentence()}`,
      `## step 2: ${faker.lorem.sentence()}`,
      `### Step 3 - ${faker.lorem.sentence()}`,
      '#### Step 4',
    ].join('\r\n');
    const slices = [1, 2, 3, 4].map((step) => aSliceClaiming(implementingPlanSteps(step)));

    expect(checkPlanCoverage(plan, slices).isOk()).toBe(true);
  });

  it('rejects a plan step no slice implements', () => {
    const { plan } = setup({ steps: [1, 2] });
    const slices = [aSliceClaiming(implementingPlanSteps(1))];

    const result = checkPlanCoverage(plan, slices);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('plan step 2');
  });

  it('rejects a slice claiming a step the plan does not have', () => {
    const { plan } = setup({ steps: [1, 2] });
    const slice = aSliceClaiming(implementingPlanSteps(9));

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('plan step 9');
  });

  it('treats a claim of step zero as a step the plan does not have', () => {
    const { plan } = setup({ steps: [1] });
    const slice = aSliceClaiming('Implements plan step 0. ' + faker.lorem.paragraph());

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('plan step 0');
  });

  it('rejects a slice description without an Implements reference', () => {
    const { plan } = setup();
    const slice = aPlannedSlice();

    const result = checkPlanCoverage(plan, [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
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

  it('rejects a plan without step headings', () => {
    const slice = aSliceClaiming(implementingPlanSteps(1));

    const result = checkPlanCoverage(faker.lorem.paragraphs(), [slice]);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
  });

  it('rejects a plan whose step numbers are not consecutive from 1', () => {
    const { plan } = setup({ steps: [1, 3] });
    const slices = [aSliceClaiming(implementingPlanSteps(1, 3))];

    const result = checkPlanCoverage(plan, slices);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('1, 3');
  });

  it('rejects a plan step with more than one heading', () => {
    const plan = `${planWithSteps(1, 2)}\n## Step 2 — ${faker.lorem.sentence()}`;
    const slices = [aSliceClaiming(implementingPlanSteps(1, 2))];

    const result = checkPlanCoverage(plan, slices);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toContain('heading: 2');
  });

  it('rejects a step heading numbered below one', () => {
    const { plan } = setup({ steps: [0, 1] });
    const slices = [aSliceClaiming(implementingPlanSteps(1))];

    const result = checkPlanCoverage(plan, slices);

    expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
    expect(result.isErr() && result.error.message).toMatch(/\bnot 0\b/);
  });

  it('reports every problem in one error, in the same order every time', () => {
    const { plan } = setup({ steps: [1, 3] });
    const unreferenced = aPlannedSlice();
    const unknown = aSliceClaiming(implementingPlanSteps(9));
    const first = checkPlanCoverage(plan, [unreferenced, unknown]);
    const second = checkPlanCoverage(plan, [unreferenced, unknown]);

    expect(first.isErr() && first.error).toBeInstanceOf(AgentOutputInvalid);
    const message = first.isErr() ? first.error.message : '';
    expect(message).toContain('numbered 1, 3');
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
