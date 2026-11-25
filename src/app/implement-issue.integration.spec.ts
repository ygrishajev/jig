import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { Result } from 'better-result';
import path from 'node:path';
import type { Logger } from 'pino';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aDescription,
  approval,
  fulfillment,
  scriptPlanning,
  scriptWholeRun,
} from '../../tests/support/agent-scripts.js';
import { aPlannedSlice, everyStepOn, implementingPlanSteps } from '../../tests/support/builders.js';
import { anIssue, FakeGithub } from '../../tests/support/fake-github.js';
import { FakeAgentSession } from '../../tests/support/fakes.js';
import { openRunWorktree, sandboxCloneOf } from '../../tests/support/open-run-worktree.js';
import {
  operationContextIn,
  realRepositorySources,
} from '../../tests/support/repository-sources.js';
import { createRemote } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { configDestination } from '../adapters/filesystem/config-source.js';
import { githubOriginName } from '../adapters/git/github-origin.js';
import { GitOrchestrationStore } from '../adapters/git/orchestration-ref.js';
import { GitRunBranches } from '../adapters/git/run-branches.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { sandcastleSessionOptions } from '../adapters/sandcastle/open-session.js';
import { type RunId, runIdFor } from '../domain/run-id.js';
import { runBranchFor } from '../domain/run-state.js';
import {
  implementGithubIssue,
  type IssueCapabilities,
  type RunRuntime,
  type RuntimeRequest,
} from './api.js';
import { createAppContainer, runCapabilitiesOf } from './container.js';

describe('implementGithubIssue on real git', () => {
  it('publishes a completed run once, from any clone, without merging it or showing the sandbox a GitHub token', async () => {
    const {
      implement,
      implementFromFreshClone,
      github,
      dir,
      id,
      issue,
      store,
      key,
      agent,
      sessionCredentials,
    } = await setup({ auto: true });
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
    expect(unwrap(await implementFromFreshClone())).toEqual({
      kind: 'pullRequest',
      url: pr?.url,
      reused: true,
    });
    expect(agent.calls).toHaveLength(calls);
    expect(unwrap(await new GitRemoteRunStore(dir).load(id))?.phase).toBe('completed');
    expect(sessionCredentials).toHaveLength(1);
    for (const credentials of sessionCredentials) {
      expect(credentials).not.toHaveProperty('GITHUB_TOKEN');
      expect(credentials).not.toHaveProperty('GH_TOKEN');
    }
  });

  it('refuses a completed run that changes a workflow without publishing its code', async () => {
    const { implement, github, dir, id, store, key, workflow } = await setup({ workflow: true });

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
  });

  async function setup({
    auto = false,
    workflow = false,
  }: { auto?: boolean; workflow?: boolean } = {}) {
    const remote = await createRemote();
    const dir = await remote.cloneOf();
    const github = new FakeGithub();
    const issue = anIssue();
    github.issues.set(issue.number, issue);
    const repository = { owner: faker.string.alpha(10), repo: faker.string.alpha(10) };
    const key = `${repository.owner}/${repository.repo}#${issue.number}`;
    const id = runIdFor({ name: issue.title, key });
    const logger = mock<Logger>();
    const imageName = faker.string.alpha(10);
    const workflowPath = `.github/workflows/${faker.string.alpha(8)}.yml`;
    const agent = new FakeAgentSession(
      sandboxCloneOf(dir, id),
      () => ({ exitCode: 0, output: '' }),
      path.join(dir, '.jig', id, 'workspace'),
    );
    if (workflow) {
      scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
      agent.script('implementer', { files: { [workflowPath]: 'on: push' } });
      agent.script('reviewer', approval(), fulfillment());
      agent.script('describer', aDescription());
    } else scriptWholeRun(agent);
    const sessionCredentials: Record<string, string>[] = [];
    const openRuntime = ({ configPath, ...request }: RuntimeRequest): RunRuntime => {
      const { repoRoot } = request;
      const app = createAppContainer({
        ...request,
        logLevel: 'silent',
        configDestination: configDestination(repoRoot, configPath),
      });
      app.register({ logger: asValue(logger) });
      app.register({
        config: asValue({
          ...app.cradle.config,
          ...everyStepOn(),
          sandboxImage: imageName,
          mergeMode: auto ? 'auto' : 'manual',
          designGate: 'auto',
          reviewCycleCap: 1,
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
      return { run: runCapabilitiesOf(app), dispose: () => app.dispose() };
    };
    const environment = {
      GITHUB_TOKEN: faker.string.alphanumeric(20),
      GH_TOKEN: faker.string.alphanumeric(20),
      GITHUB_REPOSITORY: `${repository.owner}/${repository.repo}`,
    };
    const capabilitiesIn = (cwd: string): IssueCapabilities => ({
      ...realRepositorySources(),
      context: () =>
        operationContextIn(cwd, {
          ANTHROPIC_API_KEY: faker.string.alphanumeric(20),
          ...environment,
        }),
      askForPreset: async () => undefined,
      openRuntime,
      githubFor: () => github,
      githubOriginName,
      publicationAt: (repoRoot) => ({
        receipts: new GitOrchestrationStore(repoRoot),
        runBranches: new GitRunBranches(repoRoot),
      }),
    });
    const implementIn = (cwd: string) =>
      implementGithubIssue(capabilitiesIn(cwd), {
        issueNumber: issue.number,
        logFormat: 'json',
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
      store: new GitOrchestrationStore(dir),
      implement: () => implementIn(dir),
      implementFromFreshClone: async () => implementIn(await remote.cloneOf()),
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
