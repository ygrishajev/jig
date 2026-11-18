import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { panic, Result } from 'better-result';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aDescription,
  approval,
  fulfillment,
  rejection,
  scriptPlanning,
  scriptWholeRun,
} from '../../../tests/support/agent-scripts.js';
import {
  aPlannedSlice,
  aRunState,
  everyStepOn,
  failureOutput,
  implementingPlanSteps,
} from '../../../tests/support/builders.js';
import { anIssue, FakeGithub } from '../../../tests/support/fake-github.js';
import { FakeAgentSession } from '../../../tests/support/fakes.js';
import { openRunWorktree, sandboxCloneOf } from '../../../tests/support/open-run-worktree.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { GitRunCode } from '../../adapters/git/run-code.js';
import { CompositeRunStore } from '../../adapters/run-store/composite-run-store.js';
import { GitRemoteRunStore } from '../../adapters/run-store/git-remote-run-store.js';
import { sandcastleSessionOptions } from '../../adapters/sandcastle/open-session.js';
import { createAppContainer } from '../../app/container.js';
import { parseEnvironment } from '../../config/environment.js';
import { configFileFor, loadConfig } from '../../config/load-config.js';
import { runDiagnostics } from '../../domain/diagnostics.js';
import { AgentRunFailed } from '../../domain/errors.js';
import { type RunId, runIdFor } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import type { ExecResult } from '../../ports/agent-session.js';
import { GithubNotFound, GithubRefused, GithubUnavailable } from './errors.js';
import { implementIssue } from './implement-issue.js';
import {
  claimPublication,
  releasePublication,
  withComment,
  withPullRequest,
} from './orchestration-state.js';
import { OrchestrationStore } from './orchestration-store.js';
import { requestText } from './request-snapshot.js';

describe('implementIssue', () => {
  it('reports GitHub preparation before a default branch lookup fails', async () => {
    const { implement, github, issue, logger } = await setup();
    github.failOnce('getDefaultBranch', new GithubRefused({ message: faker.lorem.sentence() }));

    const result = await implement();

    expect(result.isErr()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'githubIssuePreparationStarted',
        issueNumber: issue.number,
      }),
      expect.any(String),
    );
  });

  it('reports request acceptance and the run outcome', async () => {
    const { implement, issue, id, logger } = await setup();

    const outcome = unwrap(await implement());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'githubIssueRequestStarted', issueNumber: issue.number }),
      expect.any(String),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'githubIssueRequestAccepted', runId: id }),
      expect.any(String),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'githubIssueRunFinished', runId: id, status: 'completed' }),
      expect.any(String),
    );
    expect(outcome.kind).toBe('pullRequest');
  });

  it('publishes a completed run without merging the operator branch', async () => {
    const { implement, github, dir, id, issue, store, key, agent } = await setup({ auto: true });
    const before = await simpleGit(dir).revparse(['HEAD']);
    const outcome = unwrap(await implement());
    const pr = github.pullRequests.get(runBranchFor(id));
    expect(outcome).toEqual({ kind: 'pullRequest', url: pr?.url, reused: false });
    expect(pr).toMatchObject({ draft: false, base: github.defaultBranch });
    expect(pr?.body).toContain(`Closes #${issue.number}`);
    expect(github.commentsMade).toBe(0);
    expect(await simpleGit(dir).revparse(['HEAD'])).toBe(before);
    expect(await simpleGit(dir).listRemote(['origin', `refs/jig/${id}`])).not.toBe('');
    expect(await simpleGit(dir).listRemote(['origin', `refs/heads/${runBranchFor(id)}`])).not.toBe(
      '',
    );
    expect(
      await simpleGit(dir).listRemote(['origin', `refs/heads/${github.defaultBranch}`]),
    ).toContain(before);
    expect(unwrap(await store.read()).receipts[key]).toMatchObject({ url: pr?.url });
    expect(await simpleGit(dir).show(['refs/jig/_orchestration:orchestration.json'])).toContain(
      pr?.url,
    );
    const calls = agent.calls.length;
    expect(unwrap(await implement())).toEqual({ kind: 'pullRequest', url: pr?.url, reused: true });
    expect(agent.calls).toHaveLength(calls);
    expect(unwrap(await new GitRemoteRunStore(dir).load(id))?.phase).toBe('completed');
  });

  it('never passes the GitHub tokens to the sandbox session', async () => {
    const { implement, sessionCredentials } = await setup();
    unwrap(await implement());
    expect(sessionCredentials.length).toBeGreaterThan(0);
    for (const credentials of sessionCredentials) {
      expect(credentials).not.toHaveProperty('GITHUB_TOKEN');
      expect(credentials).not.toHaveProperty('GH_TOKEN');
    }
  });

  it('reuses its accepted snapshot after the issue changes', async () => {
    const { implement, github, issue, store, key } = await setup();
    unwrap(await implement());
    const accepted = unwrap(await store.read()).requests[key];
    github.issues.set(issue.number, anIssue({ number: issue.number }));
    unwrap(await implement());
    expect(unwrap(await store.read()).requests[key]).toEqual(accepted);
    expect(github.prsOpened).toBe(1);
    expect(github.commentsMade).toBe(0);
  });

  it('retries publication after a refused PR without repeating the run', async () => {
    const { implement, github, agent } = await setup();
    github.failOnce('openPullRequest', new GithubRefused({ message: faker.lorem.sentence() }));
    expect((await implement()).isErr()).toBe(true);
    expect(agent.closed).toBe(true);
    unwrap(await implement());
    expect(github.prsOpened).toBe(1);
  });

  it('retries a failed status comment without opening a PR', async () => {
    const { implement, github } = await setup({ empty: true });
    github.failOnce('commentOnIssue', new GithubRefused({ message: faker.lorem.sentence() }));
    expect((await implement()).isErr()).toBe(true);
    unwrap(await implement());
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(1);
  });

  it('recovers a PR opened before its receipt was saved', async () => {
    const { implement, github, id } = await setup();
    const head = runBranchFor(id);
    const pr = {
      number: faker.number.int({ min: 1 }),
      url: faker.internet.url(),
      head,
      base: 'main',
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      draft: false,
    };
    github.pullRequests.set(head, pr);
    expect(unwrap(await implement())).toEqual({ kind: 'pullRequest', url: pr.url, reused: true });
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(0);
  });

  it('refuses another base branch before accepting a request', async () => {
    const { implement, dir, store } = await setup();
    await simpleGit(dir).checkoutLocalBranch(faker.string.alpha(10));
    const result = await implement();
    expect(result.isErr() && result.error._tag).toBe('BaseBranchMismatch');
    expect(unwrap(await store.read()).requests).toEqual({});
  });

  it('comments on a run paused after planning', async () => {
    const { implement, github } = await setup({ paused: true });
    expect(unwrap(await implement())).toMatchObject({ kind: 'commented', outcome: 'halted' });
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(1);
  });

  it.each([{ blocked: true }, { empty: true }, { planningBlocked: true }])(
    'comments on unfinished work and skips the same revision on rerun: %j',
    async (options) => {
      const { implement, github, store } = await setup(options);
      const outcome = unwrap(await implement());
      expect(outcome).toMatchObject({
        kind: 'commented',
        outcome: options.blocked || options.planningBlocked ? 'blocked' : 'stuck',
      });
      expect(github.comments[0].body).toContain(
        options.blocked || options.planningBlocked ? 'blocked' : 'stuck',
      );
      expect(Object.values(unwrap(await store.read()).comments)).toEqual([outcome.url]);
      expect(github.prsOpened).toBe(0);
      expect(github.commentsMade).toBe(1);
      expect(unwrap(await implement())).toEqual(outcome);
      expect(github.commentsMade).toBe(1);
    },
  );

  it('comments exactly once when a completed run commits nothing', async () => {
    const { implement, github, dir, id, issue } = await setup();
    await simpleGit(dir).branch([runBranchFor(id)]);
    unwrap(
      await new GitRemoteRunStore(dir).save(
        aRunState({
          runId: id,
          phase: 'completed',
          merge: false,
          request: requestText(issue),
        }),
      ),
    );
    expect(unwrap(await implement())).toMatchObject({ kind: 'commented', outcome: 'completed' });
    unwrap(await implement());
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(1);
  });

  it('returns an issue lookup failure without accepting a request', async () => {
    const { implement, github, store } = await setup();
    const failure = new GithubNotFound({ message: faker.lorem.sentence() });
    github.failOnce('getIssue', failure);
    const result = await implement();
    expect(result.isErr() && result.error).toBe(failure);
    expect(unwrap(await store.read()).requests).toEqual({});
    expect(github.prsOpened).toBe(0);
  });

  it('refuses a completed run that changes a workflow without publishing its code', async () => {
    const { implement, github, dir, id, store, key, agent, workflow } = await setup({
      workflow: true,
    });

    const outcome = unwrap(await implement());

    const saved = unwrap(await new GitRemoteRunStore(dir).peek(id));
    const revision = saved?.codeRevision ?? '';
    expect(outcome).toEqual({ kind: 'refused', paths: [workflow], url: github.comments[0].url });
    expect(unwrap(await store.read()).refusals).toEqual({
      [`${key}@${revision}`]: { runId: id, revision, paths: [workflow] },
    });
    expect(await remoteBranch(dir, id)).toBe('');
    expect(await remoteHasObject(dir, revision)).toBe(false);
    expect(github.prsOpened).toBe(0);
    expect(github.pullRequests.size).toBe(0);
    const calls = agent.calls.length;
    expect(unwrap(await implement())).toEqual(outcome);
    expect(unwrap(await implement())).toEqual(outcome);
    expect(agent.calls).toHaveLength(calls);
    expect(github.commentsMade).toBe(1);
    expect(github.prsOpened).toBe(0);
  });

  it('saves a refusal before commenting, so a failed comment is retried and nothing published', async () => {
    const { implement, github, dir, id, store, workflow } = await setup({ workflow: true });
    github.failOnce('commentOnIssue', new GithubRefused({ message: faker.lorem.sentence() }));

    expect((await implement()).isErr()).toBe(true);
    const saved = unwrap(await store.read());
    expect(Object.values(saved.refusals).map(({ paths }) => paths)).toEqual([[workflow]]);
    expect(saved.refusalComments).toEqual({});

    expect(unwrap(await implement())).toMatchObject({ kind: 'refused', paths: [workflow] });
    expect(github.commentsMade).toBe(1);
    expect(await remoteBranch(dir, id)).toBe('');
  });

  it.each([
    ['refusal', { workflow: true }],
    ['status', { empty: true }],
  ])(
    'finds a %s comment posted before its outcome was known instead of posting it again',
    async (_, options) => {
      const { implement, github } = await setup(options);
      github.failOnceAfterEffect(
        'commentOnIssue',
        new GithubUnavailable({ message: faker.lorem.sentence() }),
      );

      expect((await implement()).isErr()).toBe(true);
      const outcome = unwrap(await implement());

      expect(github.commentsMade).toBe(1);
      expect(outcome).toMatchObject({ url: github.comments[0].url });
      expect(unwrap(await implement())).toEqual(outcome);
      expect(github.commentsMade).toBe(1);
    },
  );

  it.each([
    ['ready', {}, 'pullRequest', 0],
    ['draft', { unfinished: true }, 'draftPullRequest', 1],
  ] as const)(
    'retries an approved %s publication with the same inspected revision',
    async (_, options, kind, comments) => {
      const { implement, github, dir, id } = await setup(options);
      const failure = new GithubRefused({ message: faker.lorem.sentence() });
      github.failOnce('openPullRequest', failure);

      const failed = await implement();
      expect(failed.isErr() && failed.error).toBe(failure);
      const revision = unwrap(await new GitRemoteRunStore(dir).peek(id))?.codeRevision;
      expect(await remoteBranch(dir, id)).toContain(revision);

      expect(unwrap(await implement())).toMatchObject({ kind, reused: false });
      expect(await remoteBranch(dir, id)).toContain(revision);
      expect(github.prsOpened).toBe(1);
      expect(github.commentsMade).toBe(comments);
    },
  );

  it.each([
    ['ready', {}, 0],
    ['draft', { unfinished: true }, 1],
  ] as const)(
    'opens one %s PR when two attempts publish the same request at once',
    async (_, options, comments) => {
      const { implement, github } = await setup(options);
      github.failOnce('openPullRequest', new GithubRefused({ message: faker.lorem.sentence() }));
      expect((await implement()).isErr()).toBe(true);

      const attempts = await Promise.all([implement(), implement()]);

      const succeeded = attempts.filter((attempt) => attempt.isOk());
      expect(succeeded.length).toBeGreaterThan(0);
      for (const attempt of attempts)
        if (attempt.isErr())
          expect(['PublicationInProgress', 'RunInProgress']).toContain(attempt.error._tag);
      expect(github.prsOpened).toBe(1);
      expect(github.commentsMade).toBe(comments);
    },
  );

  it('publishes nothing while another job owns the publication', async () => {
    const { implement, github, dir, id, store, key } = await setup();
    const owner = { token: faker.string.uuid(), expiresAt: Date.now() + 60_000 };
    unwrap(await store.update((state) => claimPublication(state, key, owner, Date.now())));

    const result = await implement();

    expect(result.isErr() && result.error._tag).toBe('PublicationInProgress');
    expect(await remoteBranch(dir, id)).toBe('');
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(0);
    expect(unwrap(await store.read()).owners[key]).toEqual(owner);
  });

  it("keeps a blocked run's code off the remote while checkpointing where it started", async () => {
    const { implement, dir, id } = await setup({ blocked: true });
    const startingCommit = await simpleGit(dir).revparse(['HEAD']);

    unwrap(await implement());

    const saved = unwrap(await new GitRemoteRunStore(dir).peek(id));
    expect(saved).toMatchObject({ codePublication: 'deferred', startingCommit });
    expect(await simpleGit(dir).revparse([runBranchFor(id)])).toBe(saved?.codeRevision);
    expect(await remoteBranch(dir, id)).toBe('');
    expect(await remoteHasObject(dir, saved?.codeRevision ?? '')).toBe(false);
  });

  it('refuses a blocked run that changes a workflow instead of posting a status comment', async () => {
    const { implement, github, dir, id, store, key, workflow } = await setup({
      blocked: true,
      workflow: true,
    });

    const outcome = unwrap(await implement());

    const revision = unwrap(await new GitRemoteRunStore(dir).peek(id))?.codeRevision ?? '';
    expect(outcome).toEqual({ kind: 'refused', paths: [workflow], url: github.comments[0].url });
    expect(github.comments[0].body).toContain(workflow);
    expect(unwrap(await store.read()).refusals).toEqual({
      [`${key}@${revision}`]: { runId: id, revision, paths: [workflow] },
    });
    expect(github.commentsMade).toBe(1);
    expect(await remoteBranch(dir, id)).toBe('');
  });

  it('inspects a blocked run before reusing a status comment recorded for its revision', async () => {
    const { implement, github, dir, id, store, workflow } = await setup({
      blocked: true,
      workflow: true,
    });
    const outcome = unwrap(await implement());
    const revision = unwrap(await new GitRemoteRunStore(dir).peek(id))?.codeRevision ?? '';
    const identity = { runId: id, outcome: 'blocked' as const, revision };
    unwrap(await store.update((state) => withComment(state, identity, faker.internet.url())));

    expect(unwrap(await implement())).toEqual(outcome);
    expect(outcome).toMatchObject({ kind: 'refused', paths: [workflow] });
    expect(github.commentsMade).toBe(1);
  });

  it('keeps the rejected review and the verification output of a stuck run through execution, reload and its findings', async () => {
    const { implement, github, dir, id, verifyCommand, failingOutput, feedback } = await setup({
      failingVerify: true,
    });

    expect(unwrap(await implement())).toMatchObject({ kind: 'draftPullRequest' });

    const saved = unwrap(await new GitRemoteRunStore(dir).peek(id));
    if (!saved) panic('The stuck run was not saved');
    const diagnostics = runDiagnostics(saved);
    const [findings] = github.comments;
    expect(findings.body).toContain(feedback);
    expect(findings.body).toContain(failingOutput);
    expect(findings.body).toContain(saved.slices[0].id);
    expect(diagnostics.unresolvedReviews.map((review) => review.feedback)).toEqual([feedback]);
    expect(diagnostics.lastVerificationFailure).toMatchObject({
      scope: { kind: 'slice', sliceId: saved.slices[0].id },
      command: verifyCommand,
      output: { captured: true, tail: failingOutput },
      current: true,
    });
  });

  it('inspects a run saved before checkpoints existed without guessing where it started', async () => {
    const { implement, github, dir, id, issue } = await setup();
    unwrap(
      await new GitRemoteRunStore(dir).save(
        aRunState({ runId: id, phase: 'completed', merge: false, request: requestText(issue) }),
      ),
    );
    const workflow = `.github/workflows/${faker.string.alpha(8)}.yml`;
    await commitOnBranch(dir, runBranchFor(id), { [workflow]: 'on: push' });

    expect(unwrap(await implement())).toMatchObject({ kind: 'refused', paths: [workflow] });
    expect(await remoteBranch(dir, id)).toBe('');
    expect(unwrap(await new GitRemoteRunStore(dir).peek(id))?.startingCommit).toBeUndefined();
    expect(github.prsOpened).toBe(0);
  });

  it('reports a restored run with no commits as unfinished after the default branch advances', async () => {
    const { implement, github, dir, id, issue, agent } = await setup();
    const git = simpleGit(dir);
    const startingCommit = await git.revparse(['HEAD']);
    const freshStore = () =>
      new CompositeRunStore([new GitRemoteRunStore(dir)], new GitRunCode(dir));
    unwrap(
      await freshStore().save(
        aRunState({
          runId: id,
          codePublication: 'deferred',
          merge: false,
          startingCommit,
          request: requestText(issue),
        }),
      ),
    );
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    await git.push('origin', 'main');
    const store = freshStore();
    const restored = unwrap(await store.load(id));
    if (!restored) panic('The initial checkpoint was not restored');
    unwrap(await store.save(aRunState({ ...restored, phase: 'stuck' })));

    expect(unwrap(await implement())).toMatchObject({ kind: 'commented', outcome: 'stuck' });
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(1);
    expect(agent.calls).toHaveLength(0);
    expect(await remoteBranch(dir, id)).toBe('');
    expect(await git.revparse([runBranchFor(id)])).toBe(startingCommit);
    expect(unwrap(await new GitRemoteRunStore(dir).peek(id))).toMatchObject({
      startingCommit,
      codeRevision: startingCommit,
      merge: false,
    });
  });

  it('opens one draft PR with one findings comment for a stuck run with commits, across reruns', async () => {
    const { implement, github, dir, id, issue, store, agent } = await setup({ unfinished: true });

    const outcome = unwrap(await implement());

    const pr = github.pullRequests.get(runBranchFor(id));
    if (!pr) panic('The stuck run opened no PR');
    const saved = unwrap(await new GitRemoteRunStore(dir).peek(id));
    const [findings] = github.comments;
    expect(outcome).toEqual({
      kind: 'draftPullRequest',
      url: pr.url,
      reused: false,
      findingsUrl: findings.url,
    });
    expect(pr).toMatchObject({ draft: true, base: github.defaultBranch, head: runBranchFor(id) });
    expect(pr.body).toContain(`Closes #${issue.number}`);
    expect(github.comments.map(({ number }) => number)).toEqual([pr.number]);
    expect(findings.body).toContain(saved?.slices[0].id);
    expect(findings.body).toContain(saved?.codeRevision);
    expect(await remoteBranch(dir, id)).toContain(saved?.codeRevision);
    expect(Object.values(unwrap(await store.read()).findingsComments)).toEqual([findings.url]);
    const calls = agent.calls.length;
    expect(unwrap(await implement())).toEqual({ ...outcome, reused: true });
    expect(unwrap(await implement())).toEqual({ ...outcome, reused: true });
    expect(agent.calls).toHaveLength(calls);
    expect(github.prsOpened).toBe(1);
    expect(github.commentsMade).toBe(1);
  });

  it('posts the findings comment on a rerun after the draft opened but its comment failed', async () => {
    const { implement, github, store, key } = await setup({ unfinished: true });
    github.failOnce('commentOnIssue', new GithubRefused({ message: faker.lorem.sentence() }));

    expect((await implement()).isErr()).toBe(true);
    const saved = unwrap(await store.read());
    expect(saved.receipts[key]).toBeDefined();
    expect(saved.findingsComments).toEqual({});

    const outcome = unwrap(await implement());
    expect(outcome).toMatchObject({
      kind: 'draftPullRequest',
      url: saved.receipts[key].url,
      reused: true,
      findingsUrl: github.comments[0].url,
    });
    expect(github.prsOpened).toBe(1);
    expect(github.commentsMade).toBe(1);
  });

  it.each([
    [
      'its response was lost',
      async ({ github }: { github: FakeGithub }) =>
        github.failOnceAfterEffect(
          'commentOnIssue',
          new GithubUnavailable({ message: faker.lorem.sentence() }),
        ),
      async () => undefined,
    ],
    [
      'its receipt failed to save',
      async ({ origin }: { origin: string }) => refuseFindingsReceipts(origin),
      async ({ origin }: { origin: string }) => acceptFindingsReceipts(origin),
    ],
  ])(
    'finds a findings comment posted when %s instead of posting it again',
    async (_, interrupt, recover) => {
      const context = await setup({ unfinished: true });
      const { implement, github, store } = context;
      await interrupt(context);

      expect((await implement()).isErr()).toBe(true);
      expect(github.commentsMade).toBe(1);
      expect(unwrap(await store.read()).findingsComments).toEqual({});
      await recover(context);

      const outcome = unwrap(await implement());
      expect(outcome).toMatchObject({
        kind: 'draftPullRequest',
        findingsUrl: github.comments[0].url,
      });
      expect(unwrap(await implement())).toEqual(outcome);
      expect(Object.values(unwrap(await store.read()).findingsComments)).toEqual([
        github.comments[0].url,
      ]);
      expect(github.commentsMade).toBe(1);
      expect(github.prsOpened).toBe(1);
    },
  );

  it('posts missing findings on a draft recorded before findings existed, past a status comment for the same revision', async () => {
    const { implement, github, dir, id, store, key } = await setup({ unfinished: true });
    github.failOnce('openPullRequest', new GithubRefused({ message: faker.lorem.sentence() }));
    expect((await implement()).isErr()).toBe(true);
    const revision = unwrap(await new GitRemoteRunStore(dir).peek(id))?.codeRevision ?? '';
    const legacy = {
      number: faker.number.int({ min: 20001, max: 30000 }),
      url: faker.internet.url(),
      head: runBranchFor(id),
      base: github.defaultBranch,
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      draft: true,
    };
    github.pullRequests.set(legacy.head, legacy);
    unwrap(
      await store.update((state) =>
        withComment(
          withPullRequest(state, key, legacy),
          { runId: id, outcome: 'stuck', revision },
          faker.internet.url(),
        ),
      ),
    );

    const outcome = unwrap(await implement());

    expect(outcome).toEqual({
      kind: 'draftPullRequest',
      url: legacy.url,
      reused: true,
      findingsUrl: github.comments[0].url,
    });
    expect(github.comments.map(({ number }) => number)).toEqual([legacy.number]);
    expect(github.prsOpened).toBe(0);
  });

  it('refuses a stuck run that changes a workflow once, recovering its lost comment, without a draft', async () => {
    const { implement, github, dir, id, issue, workflow } = await setup({
      unfinished: true,
      workflow: true,
    });
    github.failOnceAfterEffect(
      'commentOnIssue',
      new GithubUnavailable({ message: faker.lorem.sentence() }),
    );

    expect((await implement()).isErr()).toBe(true);
    const outcome = unwrap(await implement());

    expect(outcome).toEqual({ kind: 'refused', paths: [workflow], url: github.comments[0].url });
    expect(unwrap(await implement())).toEqual(outcome);
    expect(github.comments.map(({ number }) => number)).toEqual([issue.number]);
    expect(github.prsOpened).toBe(0);
    expect(await remoteBranch(dir, id)).toBe('');
  });

  it("fails on a fresh clone before publishing when the stuck run's code never left the clone that ran it", async () => {
    const { implement, implementFromFreshClone, github, dir, id, store, key } = await setup({
      unfinished: true,
    });
    const owner = { token: faker.string.uuid(), expiresAt: Date.now() + 60_000 };
    unwrap(await store.update((state) => claimPublication(state, key, owner, Date.now())));
    expect((await implement()).isErr()).toBe(true);
    unwrap(await store.update((state) => releasePublication(state, key, owner.token)));

    const result = await implementFromFreshClone();

    expect(result.isErr() && result.error._tag).toBe('RunCodeUnavailable');
    expect(await remoteBranch(dir, id)).toBe('');
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(0);
  });

  it('explains GitHub refusing a draft whose commits change no files', async () => {
    const { implement, github, dir, id, issue } = await setup();
    const git = simpleGit(dir);
    const startingCommit = await git.revparse(['HEAD']);
    await git.checkout(['-b', runBranchFor(id)]);
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    const codeRevision = await git.revparse(['HEAD']);
    await git.checkout('-');
    unwrap(
      await new GitRemoteRunStore(dir).save(
        aRunState({
          runId: id,
          phase: 'stuck',
          merge: false,
          request: requestText(issue),
          codePublication: 'deferred',
          startingCommit,
          codeRevision,
        }),
      ),
    );
    const failure = new GithubRefused({ message: faker.lorem.sentence() });
    github.failOnce('openPullRequest', failure);

    const result = await implement();

    if (!result.isErr()) panic('A refused draft PR was reported as published');
    expect(result.error).toBeInstanceOf(GithubRefused);
    expect(result.error.message).not.toBe(failure.message);
    expect(result.error.message).toContain(failure.message);
    expect(result.error.message).toContain(runBranchFor(id));
    expect(await remoteBranch(dir, id)).toContain(codeRevision);
    expect(github.commentsMade).toBe(0);
  });

  async function setup({
    paused = false,
    unfinished = false,
    empty = false,
    blocked = false,
    auto = false,
    planningBlocked = false,
    workflow = false,
    failingVerify = false,
  }: {
    paused?: boolean;
    unfinished?: boolean;
    empty?: boolean;
    blocked?: boolean;
    auto?: boolean;
    planningBlocked?: boolean;
    workflow?: boolean;
    failingVerify?: boolean;
  } = {}) {
    const remote = await createRemote();
    const dir = await remote.cloneOf();
    const github = new FakeGithub();
    const issue = anIssue();
    github.issues.set(issue.number, issue);
    const repository = { owner: faker.internet.username(), repo: faker.string.alpha(10) };
    const key = `${repository.owner}/${repository.repo}#${issue.number}`;
    const id = runIdFor({ name: issue.title, key });
    const logger = mock<Logger>();
    const imageName = faker.string.alpha(10);
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const failingOutput = failureOutput();
    const feedback = faker.lorem.sentence();
    const verifyResults: ExecResult[] = failingVerify
      ? [
          { exitCode: 0, output: faker.lorem.sentence() },
          ...Array.from({ length: 3 }, () => ({ exitCode: 1, output: failingOutput })),
        ]
      : [];
    const workflowPath = `.github/workflows/${faker.string.alpha(8)}.yml`;
    const agent = new FakeAgentSession(
      sandboxCloneOf(dir, id),
      () => verifyResults.shift() ?? { exitCode: 0, output: '' },
      path.join(dir, '.jig', id, 'workspace'),
    );
    if (planningBlocked) {
      const fail = new AgentRunFailed({ message: faker.lorem.sentence() });
      agent.script('planner', { fail }, { fail });
    } else if (paused)
      scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
    else if (unfinished || empty || blocked) {
      scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
      if (empty) agent.script('implementer', { output: {} }, { output: {} });
      else {
        agent.script('implementer', {
          files: {
            'work.txt': faker.lorem.paragraph(),
            ...(workflow ? { [workflowPath]: 'on: push' } : {}),
          },
        });
        agent.script(
          'reviewer',
          blocked ? { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) } : rejection(),
          ...(blocked ? [{ fail: new AgentRunFailed({ message: faker.lorem.sentence() }) }] : []),
        );
      }
      agent.script('describer', aDescription());
    } else if (failingVerify) {
      scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
      agent.script(
        'implementer',
        ...Array.from({ length: 4 }, () => ({
          files: { [`${faker.string.alpha(8)}.txt`]: faker.lorem.paragraph() },
        })),
      );
      agent.script('reviewer', rejection(feedback));
      agent.script('describer', aDescription());
    } else if (workflow) {
      scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
      agent.script('implementer', {
        files: { [workflowPath]: 'on: push', [`${faker.string.alpha(8)}.txt`]: faker.lorem.word() },
      });
      agent.script('reviewer', approval(), fulfillment());
      agent.script('describer', aDescription());
    } else scriptWholeRun(agent);
    const sessionCredentials: Record<string, string>[] = [];
    const appIn = (repoRoot: string) => {
      const app = createAppContainer({
        repoRoot,
        logFormat: 'json',
        logLevel: 'silent',
        configFile: configFileFor(repoRoot),
        config: unwrap(loadConfig(configFileFor(repoRoot))),
        environment: unwrap(
          parseEnvironment({
            ANTHROPIC_API_KEY: faker.string.alphanumeric(20),
            GITHUB_TOKEN: faker.string.alphanumeric(20),
            GH_TOKEN: faker.string.alphanumeric(20),
          }),
        ),
      });
      app.register({ logger: asValue(logger) });
      app.register({
        config: asValue({
          ...app.cradle.config,
          ...everyStepOn(),
          sandboxImage: imageName,
          mergeMode: auto ? 'auto' : 'manual',
          designGate: paused ? 'checkpoint' : 'auto',
          reviewCycleCap: failingVerify ? 2 : 1,
          ...(failingVerify ? { verifyCommand } : {}),
        }),
      });
      app.register({
        settings: asValue({ ...app.cradle.settings, maxStepRetries: 0, retryDelayMs: 0 }),
      });
      app.register({
        openSession: asValue(async (input: Parameters<typeof app.cradle.openSession>[0]) => {
          const { run, events } = input;
          const options = unwrap(sandcastleSessionOptions({ ...app.cradle, imageName }, input));
          sessionCredentials.push(options.credentials);
          await openRunWorktree({ repoRoot, ...run });
          return Result.ok(agent.reportUsageTo(events, run.runId));
        }),
      });
      return app;
    };
    const app = appIn(dir);
    return {
      dir,
      origin: remote.origin,
      verifyCommand,
      failingOutput,
      feedback,
      workflow: workflowPath,
      sessionCredentials,
      id,
      issue,
      key,
      repository,
      agent,
      github,
      logger,
      app,
      store: new OrchestrationStore(dir),
      implement: () => implementIssue(app, github, repository, issue.number),
      implementFromFreshClone: async () =>
        implementIssue(appIn(await remote.cloneOf()), github, repository, issue.number),
    };
  }
});

function remoteBranch(dir: string, id: RunId) {
  return simpleGit(dir).listRemote(['origin', `refs/heads/${runBranchFor(id)}`]);
}

async function remoteHasObject(dir: string, object: string) {
  const origin = (await simpleGit(dir).remote(['get-url', 'origin']))?.trim() ?? '';
  return simpleGit(origin)
    .raw(['cat-file', '-t', object])
    .then(
      () => true,
      () => false,
    );
}

async function commitOnBranch(dir: string, branch: string, files: Record<string, string>) {
  const git = simpleGit(dir);
  await git.checkout(['-b', branch]);
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), contents);
  }
  await git.add('.');
  await git.commit(faker.git.commitMessage());
  await git.checkout('-');
}

/** Makes origin refuse any orchestration update that records a findings comment. */
async function refuseFindingsReceipts(origin: string) {
  const hook = path.join(origin, 'hooks', 'pre-receive');
  await writeFile(
    hook,
    [
      '#!/bin/sh',
      'while read old new ref; do',
      '  if [ "$ref" = refs/jig/_orchestration ] && git show "$new:orchestration.json" | grep -q \'"findingsComments": {$\'; then',
      '    echo "[rejected] findings receipt" >&2',
      '    exit 1',
      '  fi',
      'done',
      '',
    ].join('\n'),
  );
  await chmod(hook, 0o755);
}

async function acceptFindingsReceipts(origin: string) {
  await rm(path.join(origin, 'hooks', 'pre-receive'));
}
