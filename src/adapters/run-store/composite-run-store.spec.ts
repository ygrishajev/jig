import { faker } from '@faker-js/faker';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aRunState } from '../../../tests/support/builders.js';
import { InMemoryRunStore } from '../../../tests/support/fakes.js';
import type { RunId } from '../../domain/run-id.js';
import type { RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';
import { CompositeRunStore } from './composite-run-store.js';

describe('CompositeRunStore', () => {
  it('loads the copy with the highest revision, whichever store holds it', async () => {
    const stale = aRunState({ phase: 'planning', revision: 3 });
    const fresher = aRunState({ runId: stale.runId, phase: 'slices', revision: 7 });
    const { store } = await setup({ copies: [stale, fresher] });

    expect((await store.load(stale.runId)).unwrap()).toEqual(fresher);
  });

  it('keeps the freshest copy when a staler one comes after it', async () => {
    const fresher = aRunState({ phase: 'slices', revision: 7 });
    const stale = aRunState({ runId: fresher.runId, phase: 'planning', revision: 3 });
    const { store } = await setup({ copies: [fresher, stale] });

    expect((await store.load(fresher.runId)).unwrap()).toEqual(fresher);
  });

  it('takes the copy listed first when two stores hold the same revision', async () => {
    const first = aRunState({ phase: 'slices', revision: 5 });
    const second = aRunState({ runId: first.runId, phase: 'planning', revision: 5 });
    const { store } = await setup({ copies: [first, second] });

    expect((await store.load(first.runId)).unwrap()).toEqual(first);
  });

  it('lets every store see the run before anything is saved', async () => {
    const state = aRunState();
    const { store, stores } = await setup({ copies: [state, undefined] });

    await store.load(state.runId);

    for (const each of stores) expect(each.load).toHaveBeenCalledWith(state.runId);
  });

  it('saves the next revision to every store, past the freshest one it loaded', async () => {
    const stale = aRunState({ revision: 2 });
    const fresher = aRunState({ runId: stale.runId, revision: 9 });
    const { store, stores } = await setup({ copies: [stale, fresher] });
    await store.load(stale.runId);

    await store.save(aRunState({ ...stale, phase: 'done' }));
    await store.save(aRunState({ ...stale, phase: 'stuck' }));

    for (const each of stores) {
      expect((await each.load(stale.runId)).unwrap()).toMatchObject({
        phase: 'stuck',
        revision: fresher.revision + 2,
      });
    }
  });

  it('starts a run it never loaded from the revision it was given', async () => {
    const state = aRunState({ revision: faker.number.int({ min: 0, max: 50 }) });
    const { store, stores } = await setup({ copies: [undefined] });

    await store.save(state);

    expect((await stores[0].load(state.runId)).unwrap()).toEqual({
      ...state,
      revision: state.revision + 1,
    });
  });

  it('peeks at the freshest copy through every store without loading any of them', async () => {
    const stale = aRunState({ revision: 3 });
    const fresher = aRunState({ runId: stale.runId, revision: 7 });
    const { store, stores } = await setup({ copies: [stale, fresher] });

    expect((await store.peek(stale.runId)).unwrap()).toEqual(fresher);
    for (const each of stores) expect(each.load).not.toHaveBeenCalled();
  });

  async function setup(input: { copies: (RunState | undefined)[] }) {
    const stores = await Promise.all(
      input.copies.map(async (copy) => {
        const memory = new InMemoryRunStore();
        if (copy) await memory.save(copy);
        return mock<RunStore>({
          load: vi.fn((runId: RunId) => memory.load(runId)),
          peek: vi.fn((runId: RunId) => memory.peek(runId)),
          save: vi.fn((state: RunState) => memory.save(state)),
        });
      }),
    );
    return { store: new CompositeRunStore(stores), stores };
  }
});
