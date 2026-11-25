import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { fakeThrowawayBranches } from '../../tests/support/fake-throwaway-branches.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import { runBranchFor } from '../domain/run-state.js';
import { SandboxUnavailable, SetupCommandFailed } from '../ports/agent-session.js';
import { GitCommandFailed } from '../ports/git-failures.js';
import type { WarningLog } from '../ports/observability.js';
import { MergeFailed } from '../ports/workspace.js';
import { type ThrowawaySandboxes, withThrowawaySandbox } from './throwaway-sandbox.js';

describe('withThrowawaySandbox', () => {
  it('preserves a failed branch lookup before opening a sandbox', async () => {
    const failure = new GitCommandFailed({
      message: faker.lorem.sentence(),
      command: 'git status',
      output: faker.lorem.sentence(),
    });
    const { sandboxes, opened } = setup({ branchLookup: failure });

    const result = await withThrowawaySandbox(sandboxes, null, async () => Result.ok());

    expect(result.isErr() && result.error).toBe(failure);
    expect(opened()).toBe(0);
  });

  it('closes the sandbox and removes its branch when the work inside it fails', async () => {
    const { sandboxes, session, opened, remaining } = setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      withThrowawaySandbox(sandboxes, null, async (): Promise<Result<void, never>> => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(session.closed).toBe(true);
    expect(opened()).toBe(1);
    expect(remaining()).toEqual([]);
  });

  it('gives up at once when the setup command fails, so the caller gets the failure', async () => {
    const failure = new SetupCommandFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.paragraph(),
    });
    const { sandboxes, opened } = setup({ failWith: failure });

    const result = await withThrowawaySandbox(sandboxes, `npm ${faker.word.verb()}`, async () =>
      Result.ok(),
    );

    expect(result.isErr() && result.error).toBe(failure);
    expect(opened()).toBe(1);
  });

  it("keeps the work's own failure when the sandbox does not close either", async () => {
    const { sandboxes, session } = setup();
    session.failCloseWith = sandboxUnavailable();
    const failure = new MergeFailed({ message: faker.lorem.sentence() });

    const result = await withThrowawaySandbox(sandboxes, null, async () => Result.err(failure));

    expect(result.isErr() && result.error).toBe(failure);
  });

  it('reports a sandbox that does not close after the work succeeded', async () => {
    const { sandboxes, session } = setup();
    const closeFailure = sandboxUnavailable();
    session.failCloseWith = closeFailure;

    const result = await withThrowawaySandbox(sandboxes, null, async () => Result.ok());

    expect(result.isErr() && result.error).toBe(closeFailure);
  });

  function setup(input: { failWith?: SetupCommandFailed; branchLookup?: GitCommandFailed } = {}) {
    const session = new FakeAgentSession(faker.system.directoryPath());
    const branches = fakeThrowawayBranches();
    let opened = 0;
    const sandboxes: ThrowawaySandboxes = {
      ...branches.operations,
      currentBranch: async () =>
        input.branchLookup ? Result.err(input.branchLookup) : branches.operations.currentBranch(),
      log: mock<WarningLog>(),
      open: async ({ runId }) => {
        opened++;
        if (input.failWith) return Result.err(input.failWith);
        branches.branches.add(runBranchFor(runId));
        return Result.ok(session);
      },
    };
    return { sandboxes, session, remaining: () => [...branches.branches], opened: () => opened };
  }
});

function sandboxUnavailable() {
  return new SandboxUnavailable({ message: faker.lorem.sentence() });
}
