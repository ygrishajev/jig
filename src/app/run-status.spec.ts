import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  aDesignFinding,
  aJigConfig,
  aRunBlockedByDesignReview,
  aRunState,
  aSlice,
  runId,
} from '../../tests/support/builders.js';
import { createRemote } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configDestination } from '../adapters/filesystem/config-source.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { parseEnvironment } from '../config/environment.js';
import { RunRequestInvalid } from '../domain/errors.js';
import type { RunId } from '../domain/run-id.js';
import { runBranchFor } from '../domain/run-state.js';
import { createAppContainer } from './container.js';
import { readRunStatus } from './run-status.js';

describe('readRunStatus', () => {
  it('finds a run that only the remote store holds', async () => {
    const { cloneOf, statusIn } = await setup();
    const state = aRunState({ phase: 'slices', slices: [aSlice()] });
    await new GitRemoteRunStore(await cloneOf()).save(state);

    const status = (await statusIn(await cloneOf(), ['git-remote'], state.runId)).unwrap();

    expect(status.state).toEqual(state);
  });

  it("reads the remote's copy without moving any of this clone's refs", async () => {
    const { cloneOf, statusIn } = await setup();
    const elsewhere = await cloneOf();
    const state = aRunState({ phase: 'slices', slices: [aSlice()] });
    await commitOnRunBranch(elsewhere, state.runId);
    await new GitRemoteRunStore(elsewhere).save(state);
    const here = await cloneOf();
    const refsBefore = await allRefs(here);

    const status = (await statusIn(here, ['git-remote'], state.runId)).unwrap();

    expect(status.state).toEqual(state);
    expect(await allRefs(here)).toEqual(refsBefore);
  });

  it("shows the remote's copy when this machine's local copy is older", async () => {
    const { cloneOf, statusIn } = await setup();
    const here = await cloneOf();
    const stale = aRunState({ phase: 'planning', revision: 1 });
    await new LocalRunStore(here).save(stale);
    const fresher = aRunState({ ...stale, phase: 'slices', revision: 5, slices: [aSlice()] });
    await new GitRemoteRunStore(await cloneOf()).save(fresher);

    const status = (await statusIn(here, ['local', 'git-remote'], stale.runId)).unwrap();

    expect(status.state).toEqual(fresher);
  });

  it('explains a run the design review blocked elsewhere from its saved state alone', async () => {
    const { cloneOf, statusIn } = await setup();
    const outstanding = [aDesignFinding(), aDesignFinding()];
    const state = aRunBlockedByDesignReview({ outstanding });
    await new GitRemoteRunStore(await cloneOf()).save(state);

    const status = (await statusIn(await cloneOf(), ['git-remote'], state.runId)).unwrap();

    expect(status.documents).toEqual([]);
    expect(status.state).toEqual(state);
    for (const finding of outstanding) expect(status.state.blockedReason).toContain(finding.id);
  });

  it('refuses a run that no configured store holds', async () => {
    const { cloneOf, statusIn } = await setup();

    const result = await statusIn(await cloneOf(), ['local', 'git-remote'], runId());

    expect(result.isErr() && result.error).toBeInstanceOf(RunRequestInvalid);
  });

  async function setup() {
    const { cloneOf } = await createRemote();
    const statusIn = async (repoRoot: string, runStores: string[], id: RunId) => {
      const app = createAppContainer({
        repoRoot,
        configDestination: configDestination(repoRoot),
        logFormat: 'json',
        logLevel: 'silent',
        environment: unwrap(parseEnvironment({}, faker.system.directoryPath())),
        config: aJigConfig(),
      });
      onTestFinished(() => app.dispose());
      app.register({
        config: asValue({ ...aJigConfig(), runStores }),
      });
      return readRunStatus(app, id);
    };
    return { cloneOf, statusIn };
  }
});

async function allRefs(repo: string) {
  return simpleGit({ baseDir: repo }).raw(['for-each-ref', '--format=%(refname) %(objectname)']);
}

async function commitOnRunBranch(repo: string, id: RunId) {
  const git = simpleGit({ baseDir: repo });
  await git.checkoutLocalBranch(runBranchFor(id));
  await writeFile(path.join(repo, `${faker.word.noun()}.txt`), faker.lorem.sentence());
  await git.add('-A').commit(faker.lorem.sentence());
  await git.checkout('main');
}
