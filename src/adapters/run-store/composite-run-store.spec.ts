import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aFirstDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
} from '../../../tests/support/builders.js';
import { InMemoryRunStore } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { RunCodeUnavailable } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import type { RunState } from '../../domain/run-state.js';
import type { RunCode } from '../../ports/run-code.js';
import type { RunStore, RunStoreFailure } from '../../ports/run-store.js';
import { LocalRunStore } from '../local-store/local-run-store.js';
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

  it('loads the design review evidence of the freshest copy from stores that serialize it', async () => {
    const stale = aRunState({
      phase: 'revisingDesign',
      designReview: aFirstDesignReview(),
      revision: 4,
    });
    const fresher = aRunState({
      ...stale,
      phase: 'reviewingDesign',
      designReview: aRevisionAwaitingReReview(),
      revision: 5,
    });
    const { store } = await setup({ copies: [stale, fresher], serialized: true });

    expect((await store.load(stale.runId)).unwrap()).toEqual(fresher);
  });

  it('records the run branch commit with each save of a run that defers its code', async () => {
    const state = aRunState({ codePublication: 'deferred', codeRevision: faker.git.commitSha() });
    const checkpoint = faker.git.commitSha();
    const { store, stores } = await setup({ copies: [undefined, undefined], checkpoint });

    unwrap(await store.save(state));

    for (const each of stores)
      expect(unwrap(await each.load(state.runId))?.codeRevision).toBe(checkpoint);
  });

  it('keeps the recorded checkpoint while the run branch has no commit here', async () => {
    const state = aRunState({ codePublication: 'deferred', codeRevision: faker.git.commitSha() });
    const { store, stores } = await setup({ copies: [undefined] });

    unwrap(await store.save(state));

    expect(unwrap(await stores[0].load(state.runId))?.codeRevision).toBe(state.codeRevision);
  });

  it('neither records nor restores code for a run that publishes it with its state', async () => {
    const state = aRunState({ codeRevision: faker.git.commitSha() });
    const { store, stores, code } = await setup({ copies: [state] });

    unwrap(await store.load(state.runId));
    unwrap(await store.save(state));

    expect(unwrap(await stores[0].load(state.runId))?.codeRevision).toBe(state.codeRevision);
    expect(code.checkpoint).not.toHaveBeenCalled();
    expect(code.restore).not.toHaveBeenCalled();
  });

  it('restores the code checkpoint of the copy it loads', async () => {
    const stale = aRunState({
      codePublication: 'deferred',
      codeRevision: faker.git.commitSha(),
      revision: 2,
    });
    const fresher = { ...stale, codeRevision: faker.git.commitSha(), revision: 3 };
    const { store, code } = await setup({ copies: [stale, fresher] });

    expect(unwrap(await store.load(stale.runId))).toEqual(fresher);
    expect(code.restore).toHaveBeenCalledWith(stale.runId, fresher.codeRevision);
  });

  it('returns the failure to restore code instead of the run', async () => {
    const state = aRunState({ codePublication: 'deferred', codeRevision: faker.git.commitSha() });
    const failure = new RunCodeUnavailable({ message: faker.lorem.sentence() });
    const { store } = await setup({ copies: [state], restored: Result.err(failure) });

    const loaded = await store.load(state.runId);

    expect(loaded.isErr() && loaded.error).toBe(failure);
  });

  it('refuses copies of one revision that record different code checkpoints', async () => {
    const first = aRunState({ codePublication: 'deferred', codeRevision: faker.git.commitSha() });
    const second = { ...first, codeRevision: faker.git.commitSha() };
    const { store, code } = await setup({ copies: [first, second] });

    const loaded = await store.load(first.runId);

    expect(loaded.isErr() && loaded.error._tag).toBe('RunStateConflict');
    expect(code.restore).not.toHaveBeenCalled();
  });

  async function setup(input: {
    copies: (RunState | undefined)[];
    serialized?: boolean;
    checkpoint?: string;
    restored?: Result<void, RunStoreFailure>;
  }) {
    const stores = await Promise.all(
      input.copies.map(async (copy) => {
        const memory = input.serialized
          ? new LocalRunStore(await tempDirectory('jig-store-'))
          : new InMemoryRunStore();
        if (copy) await memory.save(copy);
        return mock<RunStore>({
          load: vi.fn((runId: RunId) => memory.load(runId)),
          peek: vi.fn((runId: RunId) => memory.peek(runId)),
          save: vi.fn((state: RunState) => memory.save(state)),
        });
      }),
    );
    const code = mock<RunCode>({
      checkpoint: vi.fn().mockResolvedValue(Result.ok(input.checkpoint)),
      restore: vi.fn().mockResolvedValue(input.restored ?? Result.ok()),
    });
    return { store: new CompositeRunStore(stores, code), stores, code };
  }
});
