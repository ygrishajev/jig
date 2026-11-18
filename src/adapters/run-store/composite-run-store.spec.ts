import { faker } from '@faker-js/faker';
import { panic, Result } from 'better-result';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aFirstDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
  aSlice,
} from '../../../tests/support/builders.js';
import { InMemoryRunStore } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { RunCodeUnavailable } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor, type RunState } from '../../domain/run-state.js';
import type { RunCode } from '../../ports/run-code.js';
import type { RunStore, RunStoreFailure } from '../../ports/run-store.js';
import { GitRunCode } from '../git/run-code.js';
import { LocalRunStore } from '../local-store/local-run-store.js';
import { CompositeRunStore } from './composite-run-store.js';
import { GitRemoteRunStore } from './git-remote-run-store.js';

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

  it.each([
    ['listed first', 0],
    ['listed second', 1],
  ])('refuses a tied copy without a checkpoint whether it is %s', async (_order, missingAt) => {
    const checkpointed = aRunState({
      codePublication: 'deferred',
      codeRevision: faker.git.commitSha(),
    });
    const { codeRevision: _dropped, ...missing } = checkpointed;
    const copies = missingAt === 0 ? [missing, checkpointed] : [checkpointed, missing];
    const { store, code } = await setup({ copies });

    const loaded = await store.load(checkpointed.runId);
    const peeked = await store.peek(checkpointed.runId);

    expect(loaded.isErr() && loaded.error._tag).toBe('RunStateConflict');
    expect(peeked.isErr() && peeked.error._tag).toBe('RunStateConflict');
    expect(code.restore).not.toHaveBeenCalled();
  });

  it.each([
    ['listed first', 0],
    ['listed second', 1],
  ])(
    'refuses a tied copy with another publication policy whether it is %s',
    async (_order, publishedAt) => {
      const deferred = aRunState({ codePublication: 'deferred' });
      const { codePublication: _dropped, ...published } = deferred;
      const copies = publishedAt === 0 ? [published, deferred] : [deferred, published];
      const { store } = await setup({ copies });

      const loaded = await store.load(deferred.runId);
      const peeked = await store.peek(deferred.runId);

      expect(loaded.isErr() && loaded.error._tag).toBe('RunStateConflict');
      expect(peeked.isErr() && peeked.error._tag).toBe('RunStateConflict');
    },
  );

  it('peeks at tied copies that record different checkpoints as a conflict', async () => {
    const first = aRunState({ codePublication: 'deferred', codeRevision: faker.git.commitSha() });
    const second = { ...first, codeRevision: faker.git.commitSha() };
    const { store } = await setup({ copies: [second, first] });

    const peeked = await store.peek(first.runId);

    expect(peeked.isErr() && peeked.error._tag).toBe('RunStateConflict');
  });

  it('accepts a stale copy that disagrees with the freshest one', async () => {
    const fresher = aRunState({
      codePublication: 'deferred',
      codeRevision: faker.git.commitSha(),
      revision: 4,
    });
    const { codeRevision: _dropped, ...stale } = { ...fresher, revision: 3 };
    const { store, code } = await setup({ copies: [stale, fresher] });

    expect(unwrap(await store.peek(fresher.runId))).toEqual(fresher);
    expect(unwrap(await store.load(fresher.runId))).toEqual(fresher);
    expect(code.restore).toHaveBeenCalledWith(fresher.runId, fresher.codeRevision);
  });

  it('recovers only untouched legacy state and keeps peek read-only', async () => {
    const state = aRunState({ codePublication: 'deferred', startingCommit: faker.git.commitSha() });
    const { store, code } = await setup({ copies: [state] });
    expect(unwrap(await store.peek(state.runId))).toEqual(state);
    expect(code.restore).not.toHaveBeenCalled();
    expect(unwrap(await store.load(state.runId))).toEqual({
      ...state,
      codeRevision: state.startingCommit,
    });
    expect(code.restore).toHaveBeenCalledWith(state.runId, state.startingCommit);
  });

  it.each([
    aRunState({ codePublication: 'deferred' }),
    aRunState({
      phase: 'planning',
      codePublication: 'deferred',
      startingCommit: faker.git.commitSha(),
    }),
    aRunState({
      codePublication: 'deferred',
      startingCommit: faker.git.commitSha(),
      slices: [aSlice()],
    }),
  ])('refuses saving or restoring state without a trustworthy checkpoint', async (state) => {
    const { store, code, stores } = await setup({ copies: [state] });
    const loaded = await store.load(state.runId);
    const saved = await store.save(state);
    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RunCodeUnavailable);
    expect(saved.isErr() && saved.error).toBeInstanceOf(RunCodeUnavailable);
    expect(code.restore).not.toHaveBeenCalled();
    expect(stores[0].save).not.toHaveBeenCalled();
  });

  it('recovers an initial legacy checkpoint from persisted state without using the advanced default', async () => {
    const { cloneOf } = await createRemote();
    const here = await cloneOf();
    const git = simpleGit(here);
    const startingCommit = await git.revparse(['HEAD']);
    const state = aRunState({ startingCommit, codePublication: 'deferred' });
    unwrap(await new GitRemoteRunStore(here).save(state));
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    await git.push('origin', 'main');
    const store = new CompositeRunStore([new GitRemoteRunStore(here)], new GitRunCode(here));

    expect(unwrap(await store.load(state.runId))).toEqual({
      ...state,
      codeRevision: startingCommit,
    });
    expect(await git.revparse([runBranchFor(state.runId)])).toBe(startingCommit);
    expect(await git.listRemote(['origin', `refs/heads/${runBranchFor(state.runId)}`])).toBe('');
  });

  it('restores the original start after main advances and later restores unpublished run work', async () => {
    const { origin, cloneOf } = await createRemote();
    const here = await cloneOf();
    const git = simpleGit(here);
    const startingCommit = await git.revparse(['HEAD']);
    const state = aRunState({ codePublication: 'deferred', startingCommit });
    const branch = runBranchFor(state.runId);
    const freshStore = (repo: string) =>
      new CompositeRunStore(
        [new LocalRunStore(repo), new GitRemoteRunStore(repo)],
        new GitRunCode(repo),
      );
    unwrap(await freshStore(here).save(state));
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    await git.push('origin', 'main');

    const restored = unwrap(await freshStore(here).load(state.runId));
    expect(restored).toMatchObject({ startingCommit, codeRevision: startingCommit });
    expect(await git.revparse([branch])).toBe(startingCommit);
    const worktree = await tempDirectory('jig-resume-');
    await git.raw(['worktree', 'add', worktree, branch]);
    expect(await simpleGit(worktree).revparse(['HEAD'])).toBe(startingCommit);
    await writeFile(path.join(worktree, 'run.txt'), faker.lorem.paragraph());
    await simpleGit(worktree).add('run.txt');
    await simpleGit(worktree).commit(faker.git.commitMessage());
    const codeRevision = await simpleGit(worktree).revparse(['HEAD']);
    const store = freshStore(here);
    const loaded = unwrap(await store.load(state.runId));
    if (!loaded) panic('The initial checkpoint was not restored');
    unwrap(await store.save(loaded));
    await git.raw(['worktree', 'remove', worktree]);
    await git.branch(['-D', branch]);

    const resumed = unwrap(await freshStore(here).load(state.runId));
    expect(resumed).toMatchObject({ startingCommit, codeRevision });
    expect(await git.revparse([branch])).toBe(codeRevision);
    expect(await git.listRemote(['origin', `refs/heads/${branch}`])).toBe('');
    const stateHistory = await git.raw(['rev-list', `refs/jig/${state.runId}`]);
    expect(stateHistory.split('\n')).not.toContain(startingCommit);
    expect(stateHistory.split('\n')).not.toContain(codeRevision);
    const elsewhere = await cloneOf();
    await simpleGit(elsewhere).fetch(['origin', `+refs/jig/*:refs/jig/*`]);
    for (const repo of [origin, elsewhere]) {
      expect(
        await simpleGit(repo)
          .raw(['cat-file', '-t', codeRevision])
          .then(
            () => true,
            () => false,
          ),
      ).toBe(false);
    }
    const unavailable = await freshStore(elsewhere).load(state.runId);
    expect(unavailable.isErr() && unavailable.error).toBeInstanceOf(RunCodeUnavailable);
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
