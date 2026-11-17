import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it, onTestFinished } from 'vitest';

import { FakeAgentSession } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createTempRepo } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import type { OpenSessionInput } from '../adapters/sandcastle/open-session.js';
import { parseEnvironment } from '../config/environment.js';
import { configFileFor, loadConfig } from '../config/load-config.js';
import { MergeFailed, SandboxUnavailable, SetupCommandFailed } from '../domain/errors.js';
import { runBranchFor } from '../domain/run-state.js';
import { createAppContainer } from './container.js';
import { withThrowawaySandbox } from './throwaway-sandbox.js';

describe('withThrowawaySandbox', () => {
  it('closes the sandbox and removes its branch when the work inside it fails', async () => {
    const { app, session, branches, repoRoot } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      withThrowawaySandbox(app, null, async (): Promise<Result<void, never>> => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(session.closed).toBe(true);
    expect(branches.length).toBe(1);
    expect((await simpleGit({ baseDir: repoRoot }).branchLocal()).all).not.toContain(branches[0]);
  });

  it('gives up at once when the setup command fails, so the caller gets the failure', async () => {
    const failure = new SetupCommandFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.paragraph(),
    });
    const { app, opened } = await setup({ failWith: failure });

    const result = await withThrowawaySandbox(app, `npm ${faker.word.verb()}`, async () =>
      Result.ok(),
    );

    expect(result.isErr() && result.error).toBe(failure);
    expect(opened()).toBe(1);
  });

  it("keeps the work's own failure when the sandbox does not close either", async () => {
    const { app, session } = await setup();
    session.failCloseWith = sandboxUnavailable();
    const failure = new MergeFailed({ message: faker.lorem.sentence() });

    const result = await withThrowawaySandbox(app, null, async () => Result.err(failure));

    expect(result.isErr() && result.error).toBe(failure);
  });

  it('reports a sandbox that does not close after the work succeeded', async () => {
    const { app, session } = await setup();
    const closeFailure = sandboxUnavailable();
    session.failCloseWith = closeFailure;

    const result = await withThrowawaySandbox(app, null, async () => Result.ok());

    expect(result.isErr() && result.error).toBe(closeFailure);
  });

  it('removes the worktree the closed sandbox leaves behind, with its branch', async () => {
    const { app, repoRoot, worktreeOf, branchOf } = await setup({ withWorktree: true });

    const result = await withThrowawaySandbox(app, null, async (session) =>
      Result.ok(session.worktreePath),
    );

    expect(unwrap(result)).toBe(worktreeOf());
    expect((await simpleGit({ baseDir: repoRoot }).branchLocal()).all).not.toContain(branchOf());
    expect(
      await simpleGit({ baseDir: repoRoot }).raw(['worktree', 'list', '--porcelain']),
    ).not.toContain(worktreeOf());
  });

  async function setup(input: { failWith?: SetupCommandFailed; withWorktree?: boolean } = {}) {
    const { dir: repoRoot } = await createTempRepo();
    const session = new FakeAgentSession(repoRoot);
    const branches: string[] = [];
    const worktrees: string[] = [];
    let opened = 0;
    const app = createAppContainer({
      repoRoot,
      configFile: configFileFor(repoRoot),
      logFormat: 'json',
      logLevel: 'silent',
      environment: unwrap(parseEnvironment({})),
      config: unwrap(loadConfig(configFileFor(repoRoot))),
    });
    app.register({
      openSession: asValue(async ({ run }: OpenSessionInput) => {
        opened++;
        if (input.failWith) return Result.err(input.failWith);
        const branch = runBranchFor(run.runId);
        if (input.withWorktree) {
          const worktree = path.join(
            await tempDirectory('jig-worktree-'),
            branch.replaceAll('/', '-'),
          );
          await simpleGit({ baseDir: repoRoot }).raw(['worktree', 'add', '-b', branch, worktree]);
          worktrees.push(worktree);
          branches.push(branch);
          return Result.ok(new FakeAgentSession(worktree));
        }
        await simpleGit({ baseDir: repoRoot }).branch([branch]);
        branches.push(branch);
        return Result.ok(session);
      }),
    });
    onTestFinished(() => app.dispose());
    onTestFinished(async () => {
      const git = simpleGit({ baseDir: repoRoot });
      for (const worktree of worktrees) {
        await git.raw(['worktree', 'remove', '--force', worktree]).catch(() => undefined);
      }
    });
    return {
      app,
      session,
      branches,
      repoRoot,
      opened: () => opened,
      worktreeOf: () => worktrees[0],
      branchOf: () => branches[0],
    };
  }
});

function sandboxUnavailable() {
  return new SandboxUnavailable({ message: faker.lorem.sentence() });
}
