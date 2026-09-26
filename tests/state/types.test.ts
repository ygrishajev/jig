import { describe, expect, it } from 'vitest';
import {
  runMetaSchema,
  sliceSchema,
  sliceStatusSchema,
  slicesSchema,
} from '../../src/state/types.js';

describe('state schemas', () => {
  it('accepts every status defined in the slice status enum', () => {
    const statuses = ['pending', 'implementing', 'in_review', 'ready_to_merge', 'merged', 'stuck'];
    for (const status of statuses) {
      expect(sliceStatusSchema.parse(status)).toBe(status);
    }
  });

  it('accepts a valid slice list', () => {
    const parsed = slicesSchema.parse([
      {
        id: 'add-auth-middleware',
        title: 'Add auth middleware',
        description: 'Add the auth middleware that checks the session token.',
        order: 0,
        status: 'pending',
        branch: 'sdlc/slice/run1/add-auth-middleware',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it('rejects an invalid slice status', () => {
    expect(() =>
      slicesSchema.parse([
        {
          id: 'x',
          title: 'x',
          description: 'x',
          order: 0,
          status: 'not-a-real-status',
          branch: 'x',
          reviewCycles: 0,
          mergeAttempts: 0,
        },
      ]),
    ).toThrow();
  });

  it('accepts a slice with lastFeedback set and defaults it to undefined when absent', () => {
    const withFeedback = sliceSchema.parse({
      id: 'x',
      title: 'x',
      description: 'x',
      order: 0,
      status: 'pending',
      branch: 'x',
      reviewCycles: 1,
      mergeAttempts: 0,
      lastFeedback: 'Missing a test for the error path.',
    });
    expect(withFeedback.lastFeedback).toBe('Missing a test for the error path.');

    const withoutFeedback = sliceSchema.parse({
      id: 'y',
      title: 'y',
      description: 'y',
      order: 0,
      status: 'pending',
      branch: 'y',
      reviewCycles: 0,
      mergeAttempts: 0,
    });
    expect(withoutFeedback.lastFeedback).toBeUndefined();
  });

  it('rejects a slice id with characters unsafe for a git branch name', () => {
    // A slice id is interpolated directly into `sdlc/slice/<runId>/<id>` as a
    // branch name, so anything but lowercase alphanumerics and hyphens must
    // be rejected rather than accepted as arbitrary agent-provided text.
    expect(() =>
      sliceSchema.parse({
        id: 'Add Auth/Middleware!',
        title: 'x',
        description: 'x',
        order: 0,
        status: 'pending',
        branch: 'x',
        reviewCycles: 0,
        mergeAttempts: 0,
      }),
    ).toThrow(/lowercase/);
  });

  it('parses run meta', () => {
    const meta = runMetaSchema.parse({
      runId: 'abc12345',
      baseBranch: 'main',
      currentSliceId: null,
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:00.000Z',
    });
    expect(meta.runId).toBe('abc12345');
  });
});
