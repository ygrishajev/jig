import { describe, expect, it } from 'vitest';
import { aRunState, aSlice } from '../../tests/support/builders.js';
import { runPhaseSchema, runStateSchema } from './run-state.js';
import { sliceStatusSchema } from './slice.js';

describe('runStateSchema', () => {
  it.each(runPhaseSchema.options)('loads a run saved in phase %s', (phase) => {
    const state = aRunState({ phase });

    expect(runStateSchema.parse(state)).toEqual(state);
  });

  it.each([
    ['planning', 'context'],
    ['designing', 'plan'],
    ['describing', 'docs'],
    ['done', 'prDescription'],
  ] as const)('refuses a run saved in %s without its %s', (phase, missing) => {
    const { [missing]: _dropped, ...saved } = aRunState({ phase });

    expect(runStateSchema.safeParse(saved).success).toBe(false);
  });

  it('loads a run saved in describing with what the earlier phases produced', () => {
    const state = aRunState({ phase: 'describing' });

    expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each(sliceStatusSchema.options)('loads a slice saved as %s', (status) => {
    const state = aRunState({ phase: 'slices', slices: [aSlice({ status })] });

    expect(runStateSchema.parse(state)).toEqual(state);
  });
});
