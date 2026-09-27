import { describe, expect, it } from 'vitest';
import {
  runBranchFor,
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
      reviewCycles: 0,
      mergeAttempts: 0,
    });
    expect(withoutFeedback.lastFeedback).toBeUndefined();
  });

  it('rejects a slice id with characters unsafe for a stable lookup key', () => {
    expect(() =>
      sliceSchema.parse({
        id: 'Add Auth/Middleware!',
        title: 'x',
        description: 'x',
        order: 0,
        status: 'pending',
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

  it('derives one stable branch name per run id, not per slice', () => {
    expect(runBranchFor('abc12345')).toBe('sdlc/run/abc12345');
    expect(runBranchFor('abc12345')).toBe(runBranchFor('abc12345'));
  });
});
