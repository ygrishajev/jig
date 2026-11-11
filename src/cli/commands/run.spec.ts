import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aRunState, aSlice, presetName, runId } from '../../../tests/support/builders.js';
import { runBranchFor } from '../../domain/run-state.js';
import { nextStep, runInputSchema } from './run.js';

describe('nextStep', () => {
  it('asks for nothing more once the run is done', () => {
    const state = aRunState({ phase: 'done' });

    expect(nextStep({ state, status: 'done' })).not.toContain(state.runId);
  });

  it('asks for the design to be read before resuming a run paused after planning', () => {
    const state = aRunState({ phase: 'paused' });

    const step = nextStep({ state, status: 'halted' });

    expect(step).toContain(`jig run --id ${state.runId}`);
    expect(step).not.toContain(runBranchFor(state.runId));
  });

  it('names the branch to merge before resuming a run waiting to be merged', () => {
    const state = aRunState({ phase: 'awaitingMerge' });

    const step = nextStep({ state, status: 'halted' });

    expect(step).toContain(runBranchFor(state.runId));
    expect(step).toContain(`jig run --id ${state.runId}`);
  });

  it('gives the reason a blocked run stopped and how to resume it', () => {
    const reason = faker.lorem.sentence();
    const state = aRunState({ phase: 'merging', blockedReason: reason });

    const step = nextStep({ state, status: 'blocked', reason });

    expect(step).toContain(reason);
    expect(step).toContain(`jig run --id ${state.runId}`);
  });

  it('names the stuck slice and its branch, and points to status rather than a resume', () => {
    const stuck = aSlice({ status: 'stuck' });
    const state = aRunState({ phase: 'stuck', slices: [aSlice({ status: 'approved' }), stuck] });

    const step = nextStep({ state, status: 'stuck' });

    expect(step).toContain(stuck.id);
    expect(step).toContain(runBranchFor(state.runId));
    expect(step).toContain(`jig status ${state.runId}`);
    expect(step).not.toContain('jig run --id');
  });
});

describe('runInputSchema', () => {
  const logFormat = 'json';

  it('starts a run from a request, named by the id when one is given', () => {
    const request = faker.system.filePath();
    const id = runId();

    expect(runInputSchema.parse({ request, logFormat }).run).toEqual({ start: request });
    expect(runInputSchema.parse({ request, id, logFormat }).run).toEqual({
      start: request,
      runId: id,
    });
  });

  it('resumes the run named by an id given alone', () => {
    const id = runId();

    expect(runInputSchema.parse({ id, logFormat }).run).toEqual({ resume: id });
  });

  it('refuses neither a request nor an id, and an id that is not a valid run id', () => {
    expect(runInputSchema.safeParse({ logFormat }).success).toBe(false);
    expect(runInputSchema.safeParse({ id: '../x', logFormat }).success).toBe(false);
    expect(
      runInputSchema.safeParse({ request: faker.system.filePath(), id: '../x', logFormat }).success,
    ).toBe(false);
  });

  it('passes on the preset it was asked for and refuses a name that could leave the presets directory', () => {
    const request = faker.system.filePath();
    const name = presetName();

    expect(runInputSchema.parse({ request, preset: name, logFormat }).preset).toEqual({
      kind: 'named',
      name,
    });
    expect(runInputSchema.safeParse({ request, preset: '../x', logFormat }).success).toBe(false);
  });

  it('asks for a preset on a bare --preset and uses none when it is left out', () => {
    const request = faker.system.filePath();

    expect(runInputSchema.parse({ request, preset: true, logFormat }).preset).toEqual({
      kind: 'ask',
    });
    expect(runInputSchema.parse({ request, logFormat }).preset).toBeUndefined();
  });
});
