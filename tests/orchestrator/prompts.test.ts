import { describe, expect, it } from 'vitest';
import {
  buildDesignPrompt,
  buildReviewPrompt,
  buildSlicePlanPrompt,
} from '../../src/orchestrator/prompts.js';

describe('buildDesignPrompt', () => {
  it('tells the agent to write the two files at paths relative to the repo root, not absolute ones', () => {
    // The agent runs inside a sandbox container that never has the host's
    // absolute path (e.g. a CI runner's /home/runner/_work/...) — only cwd,
    // which the sandbox always bind-mounts the repo root to, so a relative
    // path is the only one guaranteed to resolve the same way in both
    // places. Regression test for a prompt that used to embed the host's
    // absolute path instead, which the agent could never actually write to.
    const prompt = buildDesignPrompt(
      'request',
      'repo summary',
      'plan summary',
      'approach',
      '.sdlc/abc123/state/design.md',
      '.sdlc/abc123/state/plan.md',
    );

    expect(prompt).toContain('.sdlc/abc123/state/design.md');
    expect(prompt).toContain('.sdlc/abc123/state/plan.md');
    expect(prompt).toMatch(/relative to the repository root/i);
    expect(prompt).not.toMatch(/\/home\/|\/Users\/|^[A-Za-z]:\\/m);
  });
});

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

  it('does not require more than one slice, and ties slice size to a commit-sized unit of work', () => {
    const prompt = buildSlicePlanPrompt('plan summary', 'approach');
    expect(prompt).toMatch(/no required or minimum slice count/i);
    expect(prompt).toMatch(/exactly one slice/i);
    expect(prompt).toMatch(/becomes exactly one\s*\n?\s*commit/i);
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
