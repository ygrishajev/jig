import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import {
  aDescription,
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
import { runIdFor } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { GithubNotFound, GithubRefused } from './errors.js';
import { implementIssue } from './implement-issue.js';
import { OrchestrationStore } from './orchestration-store.js';
import { requestText } from './request-snapshot.js';

describe('implementIssue', () => {
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

  async function setup({
    paused = false,
    unfinished = false,
    empty = false,
    blocked = false,
    auto = false,
    planningBlocked = false,
  }: {
    paused?: boolean;
    unfinished?: boolean;
    empty?: boolean;
    blocked?: boolean;
    auto?: boolean;
    planningBlocked?: boolean;
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
    const imageName = faker.string.alpha(10);
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
      sessionCredentials,
      id,
      issue,
      key,
      agent,
      github,
      app,
      store: new OrchestrationStore(dir),
      implement: () => implementIssue(app, github, repository, issue.number),
    };
  }
});
