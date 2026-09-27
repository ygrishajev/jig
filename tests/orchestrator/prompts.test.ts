import { describe, expect, it } from 'vitest';
import { buildReviewPrompt, buildSlicePlanPrompt } from '../../src/orchestrator/prompts.js';

describe('buildSlicePlanPrompt', () => {
  it('demands slices that are standalone deliverables understandable on their own', () => {
    const prompt = buildSlicePlanPrompt('plan summary', 'approach');
    expect(prompt).toMatch(/standalone deliverable/);
    expect(prompt).toMatch(/understand.*why.*change exists|understand why the change exists/i);
  });

  it('forbids prerequisite-only slices and tells the planner to fold them into consumers', () => {
    const prompt = buildSlicePlanPrompt('plan summary', 'approach');
    expect(prompt).toMatch(/prerequisite/i);
    expect(prompt).toMatch(/fold/i);
  });

  it('bounds each slice so a reviewer can skim-review it in about ten minutes', () => {
    const prompt = buildSlicePlanPrompt('plan summary', 'approach');
    expect(prompt).toMatch(/10 minutes/);
  });
});

describe('buildReviewPrompt', () => {
  const slice = {
    id: 'some-slice',
    title: 'Some Slice',
    description: 'Does something.',
    order: 0,
    status: 'ready_to_merge' as const,
    reviewCycles: 0,
  };

  it('instructs the reviewer to reject slices that are not self-explanatory standalone changes', () => {
    const prompt = buildReviewPrompt(slice);
    expect(prompt).toMatch(/standalone/i);
    expect(prompt).toMatch(/reject/i);
  });
});
