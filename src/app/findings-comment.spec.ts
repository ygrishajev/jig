import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aFailedVerification,
  aFinalCheckResult,
  aRejectedReview,
  aRunState,
  aSlice,
  capturedOutput,
  failureOutput,
} from '../../tests/support/builders.js';
import { OUTPUT_UNAVAILABLE } from '../domain/diagnostics.js';
import type { FailedVerification } from '../domain/slice.js';
import { findingsCommentBody, stuckReason } from './findings-comment.js';

describe('findingsCommentBody', () => {
  it('states why the run stopped, at which revision, and each unresolved review', () => {
    const { state, revision, body } = setup({});

    expect(body).toContain(stuckReason(state));
    expect(body).toContain(revision);
    for (const slice of state.slices) {
      expect(body).toContain(slice.id);
      expect(body).toContain(slice.rejectedReview?.feedback);
    }
  });

  it('keeps the latest verification output verbatim in a fenced block', () => {
    const tail = failureOutput();
    const { body, failed } = setup({ failed: { output: capturedOutput(tail) } });

    expect(body).toContain(failed.command);
    expect(body).toContain(`\`\`\`text\n${tail}\n\`\`\``);
  });

  it('fences output with more backticks than any run inside it', () => {
    const tail = `${failureOutput()}\n\`\`\`\`\n${failureOutput()}`;
    const { body } = setup({ failed: { output: capturedOutput(tail) } });

    expect(body).toContain(`\`\`\`\`\`text\n${tail}\n\`\`\`\`\``);
  });

  it('tells a failure that passed since apart from one still failing', () => {
    const failed = aFailedVerification();
    const current = setup({ failed });
    const passed = setup({ failed: { ...failed, passedSince: true }, state: current.state });

    expect(passed.body).not.toBe(current.body);
  });

  it('admits output a run never kept rather than showing an empty block', () => {
    const { body } = setup({ failed: { output: OUTPUT_UNAVAILABLE } });

    expect(body).not.toContain('```');
  });

  it('lists the gaps of an unfulfilled final check', () => {
    const gaps = [faker.lorem.sentence(), faker.lorem.sentence()];
    const { body } = setup({ finalCheck: { fulfilled: false, gaps } });

    for (const gap of gaps) expect(body).toContain(gap);
  });

  it('identifies the slice scope of a retained verification failure', () => {
    const { state, body } = setup({});

    expect(body).toContain(`slice \`${state.slices[0].id}\``);
  });

  it('identifies the final check round of a retained verification failure', () => {
    const failed = aFailedVerification();
    const round = faker.number.int({ min: 1, max: 2 });
    const state = aRunState({ failedFinalVerification: { ...failed, round } });

    const body = findingsCommentBody(state, faker.git.commitSha());

    expect(body).toContain(`round ${round} of the final check`);
    expect(body).toContain(failed.command);
  });

  function setup(input: {
    failed?: Partial<FailedVerification>;
    finalCheck?: { fulfilled: boolean; gaps: string[] };
    state?: ReturnType<typeof aRunState>;
  }) {
    const failed = aFailedVerification(input.failed);
    const base =
      input.state ??
      aRunState({
        phase: 'stuck',
        slices: [
          aSlice({ status: 'stuck', rejectedReview: aRejectedReview() }),
          aSlice({ status: 'pending', rejectedReview: aRejectedReview() }),
        ],
        ...(input.finalCheck ? { finalCheck: aFinalCheckResult(input.finalCheck) } : {}),
      });
    const [first, ...rest] = base.slices;
    const state = { ...base, slices: [{ ...first, failedVerification: failed }, ...rest] };
    const revision = faker.git.commitSha();
    return { state, revision, failed, body: findingsCommentBody(state, revision) };
  }
});
