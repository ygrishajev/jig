import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import { mkdir, writeFile } from 'node:fs/promises';
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
  implementingPlanSteps,
} from '../../../tests/support/builders.js';
import { anIssue, FakeGithub } from '../../../tests/support/fake-github.js';
import { FakeAgentSession } from '../../../tests/support/fakes.js';
import { openRunWorktree, sandboxCloneOf } from '../../../tests/support/open-run-worktree.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { GitRemoteRunStore } from '../../adapters/run-store/git-remote-run-store.js';
import { sandcastleSessionOptions } from '../../adapters/sandcastle/open-session.js';
import { createAppContainer } from '../../app/container.js';
import { parseEnvironment } from '../../config/environment.js';
import { configFileFor, loadConfig } from '../../config/load-config.js';
import { AgentRunFailed } from '../../domain/errors.js';
import { type RunId, runIdFor } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { GithubNotFound, GithubRefused, GithubUnavailable } from './errors.js';
import { implementIssue } from './implement-issue.js';
import { claimPublication } from './orchestration-state.js';
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

  it.each([{ unfinished: true }, { blocked: true }, { empty: true }, { planningBlocked: true }])(
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

  it('retries an approved publication with the same inspected revision', async () => {
    const { implement, github, dir, id } = await setup();
    github.failOnce('openPullRequest', new GithubRefused({ message: faker.lorem.sentence() }));

    expect((await implement()).isErr()).toBe(true);
    const revision = unwrap(await new GitRemoteRunStore(dir).peek(id))?.codeRevision;
    expect(await remoteBranch(dir, id)).toContain(revision);

    expect(unwrap(await implement())).toMatchObject({ kind: 'pullRequest', reused: false });
    expect(await remoteBranch(dir, id)).toContain(revision);
    expect(github.prsOpened).toBe(1);
  });

  it('opens one PR when two attempts publish the same request at once', async () => {
    const { implement, github } = await setup();
    github.failOnce('openPullRequest', new GithubRefused({ message: faker.lorem.sentence() }));
    expect((await implement()).isErr()).toBe(true);

    const attempts = await Promise.all([implement(), implement()]);

    const succeeded = attempts.filter((attempt) => attempt.isOk());
    expect(succeeded.length).toBeGreaterThan(0);
    for (const attempt of attempts)
      if (attempt.isErr())
        expect(['PublicationInProgress', 'RunInProgress']).toContain(attempt.error._tag);
    expect(github.prsOpened).toBe(1);
  });

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

  it("keeps an unfinished run's code off the remote while checkpointing where it started", async () => {
    const { implement, dir, id } = await setup({ unfinished: true });
    const startingCommit = await simpleGit(dir).revparse(['HEAD']);

    unwrap(await implement());

    const saved = unwrap(await new GitRemoteRunStore(dir).peek(id));
    expect(saved).toMatchObject({ codePublication: 'deferred', startingCommit });
    expect(await simpleGit(dir).revparse([runBranchFor(id)])).toBe(saved?.codeRevision);
    expect(await remoteBranch(dir, id)).toBe('');
    expect(await remoteHasObject(dir, saved?.codeRevision ?? '')).toBe(false);
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

  async function setup({
    paused = false,
    unfinished = false,
    empty = false,
    blocked = false,
    auto = false,
    planningBlocked = false,
    workflow = false,
  }: {
    paused?: boolean;
    unfinished?: boolean;
    empty?: boolean;
    blocked?: boolean;
    auto?: boolean;
    planningBlocked?: boolean;
    workflow?: boolean;
  } = {}) {
    const remote = await createRemote();
    const dir = await remote.cloneOf();
    const github = new FakeGithub();
    const issue = anIssue();
    github.issues.set(issue.number, issue);
    const repository = { owner: faker.internet.username(), repo: faker.string.alpha(10) };
    const key = `${repository.owner}/${repository.repo}#${issue.number}`;
    const id = runIdFor({ name: issue.title, key });
    const app = createAppContainer({
      repoRoot: dir,
      logFormat: 'json',
      logLevel: 'silent',
      configFile: configFileFor(dir),
      config: unwrap(loadConfig(configFileFor(dir))),
      environment: unwrap(
        parseEnvironment({
          ANTHROPIC_API_KEY: faker.string.alphanumeric(20),
          GITHUB_TOKEN: faker.string.alphanumeric(20),
          GH_TOKEN: faker.string.alphanumeric(20),
        }),
      ),
    });
    const logger = mock<Logger>();
    app.register({ logger: asValue(logger) });
    const imageName = faker.string.alpha(10);
    const workflowPath = `.github/workflows/${faker.string.alpha(8)}.yml`;
    app.register({
      config: asValue({
        ...app.cradle.config,
        ...everyStepOn(),
        sandboxImage: imageName,
        mergeMode: auto ? 'auto' : 'manual',
        designGate: paused ? 'checkpoint' : 'auto',
        reviewCycleCap: 1,
      }),
    });
    app.register({
      settings: asValue({ ...app.cradle.settings, maxStepRetries: 0, retryDelayMs: 0 }),
    });
    const agent = new FakeAgentSession(
      sandboxCloneOf(dir, id),
      undefined,
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
        agent.script('implementer', { files: { 'work.txt': faker.lorem.paragraph() } });
        agent.script(
          'reviewer',
          blocked ? { fail: new AgentRunFailed({ message: faker.lorem.sentence() }) } : rejection(),
          ...(blocked ? [{ fail: new AgentRunFailed({ message: faker.lorem.sentence() }) }] : []),
        );
      }
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
    app.register({
      openSession: asValue(async (input: Parameters<typeof app.cradle.openSession>[0]) => {
        const { run, events } = input;
        const options = unwrap(sandcastleSessionOptions({ ...app.cradle, imageName }, input));
        sessionCredentials.push(options.credentials);
        await openRunWorktree({ repoRoot: dir, ...run });
        return Result.ok(agent.reportUsageTo(events, run.runId));
      }),
    });
    return {
      dir,
      workflow: workflowPath,
      sessionCredentials,
      id,
      issue,
      key,
      agent,
      github,
      logger,
      app,
      store: new OrchestrationStore(dir),
      implement: () => implementIssue(app, github, repository, issue.number),
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
