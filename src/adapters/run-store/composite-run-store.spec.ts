import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { aRunState } from '../../../tests/support/builders.js';
import { InMemoryRunStore } from '../../../tests/support/fakes.js';
import type { RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';
import { CompositeRunStore } from './composite-run-store.js';

describe('CompositeRunStore', () => {
  it('loads from the first store that has the run, letting every store see it first', async () => {
    const state = aRunState();
    const { store, later } = await setup({ state });

    expect(await store.load(state.runId)).toEqual(state);
    expect(later.load).toHaveBeenCalledWith(state.runId);
  });

  async function setup(input: { state: RunState }) {
    const first = new InMemoryRunStore();
    await first.save(input.state);
    const later = mock<RunStore>({
      load: vi.fn().mockResolvedValue(aRunState({ runId: input.state.runId })),
    });
    return { store: new CompositeRunStore([first, later]), later };
  }
});
