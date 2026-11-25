import { faker } from '@faker-js/faker';
import { panic, Result } from 'better-result';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aJigConfig,
  aMetricsSummary,
  aRejectedReview,
  aRunState,
  aSlice,
  presetName,
  runSettings,
} from '../../tests/support/builders.js';
import { anIssue, FakeGithub } from '../../tests/support/fake-github.js';
import {
  FakeRunBranches,
  InMemoryPublicationReceipts,
} from '../../tests/support/fake-publication.js';
import {
  InMemoryConfigSource,
  InMemoryPresetSource,
  InMemoryRunStore,
  RecordingEventSink,
  SteppingClock,
} from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import {
  claimPublication,
  commentMarker,
  type Orchestration,
  withComment,
  withPullRequest,
} from '../domain/orchestration.js';
import { runIdFor } from '../domain/run-id.js';
import { runBranchFor } from '../domain/run-state.js';
import type { RunSettings } from '../domain/settings.js';
import {
  AgentRunFailed,
  type AgentSession,
  SandboxCredentialsInvalid,
} from '../ports/agent-session.js';
import { RemoteUnavailable, RepositoryInvalid } from '../ports/git-failures.js';
import {
  GithubNotFound,
  GithubRefused,
  GithubSetupInvalid,
  GithubUnavailable,
} from '../ports/github.js';
import { PublicationInProgress } from '../ports/publication-receipts.js';
import type { InvocationRecords } from '../ports/run-records.js';
import { RunCodeUnavailable } from '../ports/run-state-failures.js';
import type { Workspace } from '../ports/workspace.js';
import {
  implementGithubIssue,
  type IssueCapabilities,
  type PresetPick,
  type RunLog,
  type RunPreparation,
  type RunSandbox,
  type RuntimeRequest,
} from './api.js';
import { BaseBranchMismatch } from './errors.js';
import { requestText } from './request-snapshot.js';

describe('implementGithubIssue', () => {
  it('refuses a missing token before asking for the origin or building the run', async () => {
    const { implement, originName, githubFor, openRuntime } = setup({ environment: {} });

    const result = await implement();

    expect(result.isErr() && result.error).toBeInstanceOf(GithubSetupInvalid);
    expect(originName).not.toHaveBeenCalled();
    expect(githubFor).not.toHaveBeenCalled();
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty token', { GITHUB_TOKEN: '' }],
    ['a malformed repository', { GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'no-owner' }],
  ])('refuses %s before building the run', async (_, environment) => {
    const { implement, openRuntime } = setup({ environment });

    const result = await implement();

    if (!result.isErr()) panic('Unusable GitHub settings were accepted');
    expect(result.error).toBeInstanceOf(GithubSetupInvalid);
    expect(result.error.message).not.toBe('');
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it('asks for the origin of the clone it runs in and refuses one not on GitHub before building the run', async () => {
    const { implement, originName, openRuntime, cwd } = setup({
      environment: { GITHUB_TOKEN: faker.string.alphanumeric(20) },
    });

    const result = await implement();

    expect(originName).toHaveBeenCalledWith(cwd);
    expect(result.isErr() && result.error).toBeInstanceOf(GithubSetupInvalid);
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it('returns the failure to read the origin as it is', async () => {
    const failure = new GithubSetupInvalid({ message: faker.lorem.sentence() });
    const { implement, originName } = setup({
      environment: { GITHUB_TOKEN: faker.string.alphanumeric(20) },
    });
    originName.mockResolvedValue(Result.err(failure));

    const result = await implement();

    expect(result.isErr() && result.error).toBe(failure);
  });

  it.each([
    ['GITHUB_TOKEN when GH_TOKEN is set as well', { GITHUB_TOKEN: 'first', GH_TOKEN: 'second' }],
    ['GH_TOKEN when it is the only token', { GH_TOKEN: 'first' }],
  ])('reaches GitHub with %s', async (_, tokens) => {
    const { implement, githubFor } = setup({
      environment: { ...tokens, GITHUB_REPOSITORY: 'owner/repository' },
    });

    await implement();

    expect(githubFor).toHaveBeenCalledWith('first');
  });

  it('refuses a directory below the repository root before building the run', async () => {
    const failure = new RepositoryInvalid({ message: faker.lorem.sentence() });
    const { implement, openRuntime } = setup({ repositoryRoot: Result.err(failure) });

    const result = await implement();

    expect(result.isErr() && result.error).toBe(failure);
    expect(openRuntime).not.toHaveBeenCalled();
  });

  it('hands the run the preset the operator picks over the config file it was given', async () => {
    const preset = presetName();
    const reviewer = { provider: 'claude', model: faker.word.noun() };
    const configPath = `${faker.string.uuid()}.json`;
    const presetSource = new InMemoryPresetSource();
    presetSource.put(0, preset, { reviewer });
    const { implement, openRuntime, cwd, configSourceFor } = setup({
      config: { mergeMode: 'auto' },
      presetSource,
      pick: { kind: 'preset', name: preset },
    });

    unwrap(await implement({ configPath, preset: { kind: 'ask' } }));

    expect(configSourceFor).toHaveBeenCalledWith(cwd, configPath);
    expect(openRuntime.mock.calls[0]?.[0]).toMatchObject({
      repoRoot: cwd,
      configPath,
      config: { mergeMode: 'auto', reviewer },
    });
  });

  it('releases the run it built once the outcome is published, and once GitHub refuses', async () => {
    const { implement, github, disposed } = setup();
    github.failOnce('getDefaultBranch', aRefusal());

    expect((await implement()).isErr()).toBe(true);
    expect(disposed()).toBe(1);
    unwrap(await implement());
    expect(disposed()).toBe(2);
  });

  it('reports GitHub preparation before a default branch lookup fails', async () => {
    const { implement, github, issue, loggedEvents } = setup();
    github.failOnce('getDefaultBranch', aRefusal());

    expect((await implement()).isErr()).toBe(true);

    expect(loggedEvents()).toEqual([
      expect.objectContaining({
        event: 'githubIssuePreparationStarted',
        issueNumber: issue.number,
      }),
    ]);
  });

  it('reports request acceptance and the run outcome', async () => {
    const { implement, issue, id, loggedEvents } = setup();

    unwrap(await implement());

    expect(loggedEvents()).toEqual([
      expect.objectContaining({ event: 'githubIssuePreparationStarted' }),
      expect.objectContaining({ event: 'githubIssueRequestStarted', issueNumber: issue.number }),
      expect.objectContaining({ event: 'githubIssueRequestAccepted', runId: id }),
      expect.objectContaining({
        event: 'githubIssueRunFinished',
        runId: id,
        status: 'completed',
      }),
    ]);
  });

  it('refuses another base branch before accepting a request', async () => {
    const { implement, runBranches, receipts } = setup();
    runBranches.branch = faker.string.alpha(10);

    const result = await implement();

    if (!result.isErr()) panic('The issue was implemented off the default branch');
    expect(result.error).toBeInstanceOf(BaseBranchMismatch);
    expect(result.error.message).toContain(runBranches.branch);
    expect(receipts.state.requests).toEqual({});
  });

  it('returns an issue lookup failure without accepting a request', async () => {
    const { implement, github, receipts } = setup();
    const failure = new GithubNotFound({ message: faker.lorem.sentence() });
    github.failOnce('getIssue', failure);

    const result = await implement();

    expect(result.isErr() && result.error).toBe(failure);
    expect(receipts.state.requests).toEqual({});
    expect(github.prsOpened).toBe(0);
  });

  it('starts the accepted issue as a run that merges nothing and defers its code, saved on the remote', async () => {
    const { implement, issue, id, store, storesNamed } = setup({ run: null });

    await implement();

    expect(store.saved[0]).toMatchObject({
      runId: id,
      request: requestText(issue),
      merge: false,
      codePublication: 'deferred',
    });
    expect(storesNamed()).toContain('git-remote');
  });

  it('reuses its accepted snapshot after the issue changes', async () => {
    const { implement, github, issue, receipts, key } = setup();
    unwrap(await implement());
    const accepted = receipts.state.requests[key];
    github.issues.set(issue.number, anIssue({ number: issue.number }));

    unwrap(await implement());

    expect(receipts.state.requests[key]).toEqual(accepted);
    expect(github.prsOpened).toBe(1);
    expect(github.commentsMade).toBe(0);
  });

  it('returns a run whose code cannot be restored here without publishing anything', async () => {
    const failure = new RunCodeUnavailable({ message: faker.lorem.sentence() });
    const { implement, store, github, runBranches } = setup();
    store.failure = failure;

    const result = await implement();

    expect(result.isErr() && result.error).toBe(failure);
    expect(runBranches.published.size).toBe(0);
    expect(github.prsOpened).toBe(0);
    expect(github.commentsMade).toBe(0);
  });

  describe('a completed run', () => {
    it('is published as one ready PR, reused on a rerun', async () => {
      const { implement, github, id, issue, key, receipts, runBranches, revision } = setup();

      const outcome = unwrap(await implement());

      const pr = github.pullRequests.get(runBranchFor(id));
      expect(outcome).toEqual({ kind: 'pullRequest', url: pr?.url, reused: false });
      expect(pr).toMatchObject({ draft: false, base: github.defaultBranch, title: issue.title });
      expect(pr?.body).toContain(`Closes #${issue.number}`);
      expect(runBranches.published.get(id)).toBe(revision);
      expect(receipts.state.receipts[key]).toEqual({ number: pr?.number, url: pr?.url });
      expect(unwrap(await implement())).toEqual({ ...outcome, reused: true });
      expect(github.prsOpened).toBe(1);
      expect(github.commentsMade).toBe(0);
    });

    it('is inspected against the default branch', async () => {
      const { implement, github, id, runBranches, revision } = setup();
      github.defaultBranch = faker.string.alpha(10);
      runBranches.branch = github.defaultBranch;

      unwrap(await implement());

      expect(runBranches.inspected).toEqual([
        expect.objectContaining({ runId: id, revision, defaultBranch: github.defaultBranch }),
      ]);
    });

    it('is retried after a refused PR with the same inspected revision', async () => {
      const { implement, github, id, runBranches, revision } = setup();
      const failure = aRefusal();
      github.failOnce('openPullRequest', failure);

      const failed = await implement();
      expect(failed.isErr() && failed.error).toBe(failure);
      expect(runBranches.published.get(id)).toBe(revision);

      expect(unwrap(await implement())).toMatchObject({ kind: 'pullRequest', reused: false });
      expect(runBranches.published.get(id)).toBe(revision);
      expect(github.prsOpened).toBe(1);
      expect(github.commentsMade).toBe(0);
    });

    it('keeps its recorded PR once someone closed it, instead of opening another', async () => {
      const { implement, github } = setup();
      const outcome = unwrap(await implement());
      github.pullRequests.clear();

      expect(unwrap(await implement())).toEqual({ ...outcome, reused: true });
      expect(github.prsOpened).toBe(1);
    });

    it('recovers a PR opened before its receipt was saved', async () => {
      const { implement, github, id, receipts, key } = setup();
      const pr = anOpenPullRequest(runBranchFor(id));
      github.pullRequests.set(pr.head, pr);

      const outcome = unwrap(await implement());

      expect(outcome).toEqual({ kind: 'pullRequest', url: pr.url, reused: true });
      expect(receipts.state.receipts[key]).toEqual(expect.objectContaining({ url: pr.url }));
      expect(github.prsOpened).toBe(0);
      expect(github.commentsMade).toBe(0);
    });

    it('reuses a PR whose receipt failed to save instead of opening another', async () => {
      const { implement, github, id, receipts, key } = setup();
      const failure = new RemoteUnavailable({ message: faker.lorem.sentence() });
      receipts.failOnceSaving(({ receipts }) => key in receipts, failure);

      const first = await implement();

      expect(first.isErr() && first.error).toBe(failure);
      expect(github.prsOpened).toBe(1);
      const pr = github.pullRequests.get(runBranchFor(id));
      expect(unwrap(await implement())).toEqual({
        kind: 'pullRequest',
        url: pr?.url,
        reused: true,
      });
      expect(github.prsOpened).toBe(1);
      expect(receipts.state.receipts[key]).toMatchObject({ url: pr?.url });
    });

    it('is commented on exactly once when it changes nothing', async () => {
      const { implement, github, runBranches } = setup();
      runBranches.changesFiles = false;

      const outcome = unwrap(await implement());

      expect(outcome).toMatchObject({ kind: 'commented', outcome: 'completed' });
      expect(unwrap(await implement())).toEqual(outcome);
      expect(runBranches.published.size).toBe(0);
      expect(github.prsOpened).toBe(0);
      expect(github.commentsMade).toBe(1);
    });

    it('is commented on when it has no run branch', async () => {
      const { implement, github, id, receipts, runBranches } = setup({
        run: { codeRevision: undefined },
      });

      const outcome = unwrap(await implement());

      expect(outcome).toMatchObject({ kind: 'commented', outcome: 'completed' });
      expect(github.comments[0].body).toContain(
        commentMarker({ runId: id, outcome: 'completed', revision: 'none' }),
      );
      expect(Object.values(receipts.state.comments)).toEqual([github.comments[0].url]);
      expect(runBranches.inspected).toEqual([]);
      expect(github.prsOpened).toBe(0);
    });

    it('saved before checkpoints existed is published from where its branch stands', async () => {
      const { implement, id, runBranches } = setup({ run: { codeRevision: undefined } });
      const head = faker.git.commitSha();
      runBranches.heads.set(id, head);

      expect(unwrap(await implement())).toMatchObject({ kind: 'pullRequest' });
      expect(runBranches.published.get(id)).toBe(head);
    });

    it('whose branch moved past its checkpoint publishes nothing', async () => {
      const { implement, github, id, runBranches } = setup();
      runBranches.heads.set(id, faker.git.commitSha());

      const result = await implement();

      expect(result.isErr() && result.error._tag).toBe('RunBranchUnpublishable');
      expect(runBranches.published.size).toBe(0);
      expect(github.prsOpened).toBe(0);
    });

    it('that changes a workflow is refused once, with nothing published', async () => {
      const { implement, github, id, key, receipts, runBranches, revision, workflow } = setup({
        refused: true,
      });

      const outcome = unwrap(await implement());

      expect(outcome).toEqual({ kind: 'refused', paths: [workflow], url: github.comments[0].url });
      expect(github.comments[0].body).toContain(workflow);
      expect(receipts.state.refusals).toEqual({
        [`${key}@${revision}`]: { runId: id, revision, paths: [workflow] },
      });
      expect(unwrap(await implement())).toEqual(outcome);
      expect(unwrap(await implement())).toEqual(outcome);
      expect(runBranches.published.size).toBe(0);
      expect(github.commentsMade).toBe(1);
      expect(github.prsOpened).toBe(0);
    });

    it('keeps the refusal first recorded for a revision', async () => {
      const { implement, runBranches } = setup({ refused: true });
      const outcome = unwrap(await implement());
      runBranches.refusedPaths = [`.github/workflows/${faker.string.alpha(8)}.yml`];

      expect(unwrap(await implement())).toEqual(outcome);
    });

    it('has its refusal saved before it is announced, so a failed comment is retried and nothing published', async () => {
      const { implement, github, receipts, runBranches, workflow } = setup({ refused: true });
      github.failOnce('commentOnIssue', aRefusal());

      expect((await implement()).isErr()).toBe(true);
      expect(Object.values(receipts.state.refusals).map(({ paths }) => paths)).toEqual([
        [workflow],
      ]);
      expect(receipts.state.refusalComments).toEqual({});

      expect(unwrap(await implement())).toMatchObject({ kind: 'refused', paths: [workflow] });
      expect(github.commentsMade).toBe(1);
      expect(runBranches.published.size).toBe(0);
    });
  });

  describe('a run that ended without publishable work', () => {
    it.each(['blocked', 'stuck'] as const)(
      'is commented on once when %s, skipping the same revision on a rerun',
      async (status) => {
        const { implement, github, receipts } = setup({ run: unfinished(status) });

        const outcome = unwrap(await implement());

        expect(outcome).toMatchObject({ kind: 'commented', outcome: status });
        expect(github.comments[0].body).toContain(status);
        expect(Object.values(receipts.state.comments)).toEqual([github.comments[0].url]);
        expect(unwrap(await implement())).toEqual(outcome);
        expect(github.prsOpened).toBe(0);
        expect(github.commentsMade).toBe(1);
      },
    );

    it('keeps its recorded comment once someone deleted it, instead of posting another', async () => {
      const { implement, github } = setup({ run: unfinished('stuck') });
      const outcome = unwrap(await implement());
      github.comments.length = 0;

      expect(unwrap(await implement())).toEqual(outcome);
      expect(github.commentsMade).toBe(1);
    });

    it('is commented on when it paused after planning', async () => {
      const { implement, github } = setup({
        run: { phase: 'gate', codeRevision: undefined },
        settings: { designGate: 'checkpoint' },
      });

      expect(unwrap(await implement())).toMatchObject({ kind: 'commented', outcome: 'halted' });
      expect(github.prsOpened).toBe(0);
      expect(github.commentsMade).toBe(1);
    });

    it('has a failed status comment retried without opening a PR', async () => {
      const { implement, github } = setup({ run: unfinished('stuck') });
      github.failOnce('commentOnIssue', aRefusal());

      expect((await implement()).isErr()).toBe(true);
      unwrap(await implement());

      expect(github.prsOpened).toBe(0);
      expect(github.commentsMade).toBe(1);
    });

    it.each([
      ['refusal', { refused: true }],
      ['status', { run: unfinished('stuck') }],
    ])(
      'finds a %s comment posted before its outcome was known instead of posting it again',
      async (_, options) => {
        const { implement, github } = setup(options);
        github.failOnceAfterEffect('commentOnIssue', aLostResponse());

        expect((await implement()).isErr()).toBe(true);
        const outcome = unwrap(await implement());

        expect(github.commentsMade).toBe(1);
        expect(outcome).toMatchObject({ url: github.comments[0].url });
        expect(unwrap(await implement())).toEqual(outcome);
        expect(github.commentsMade).toBe(1);
      },
    );

    it('keeps its code off the remote when blocked', async () => {
      const { implement, github, id, runBranches, revision } = setup({
        run: unfinished('blocked'),
      });

      unwrap(await implement());

      expect(runBranches.inspected).toEqual([
        { runId: id, revision, defaultBranch: github.defaultBranch },
      ]);
      expect(runBranches.published.size).toBe(0);
    });

    it('is refused instead of commented on when it blocked on work that changes a workflow', async () => {
      const { implement, github, id, key, receipts, revision, workflow } = setup({
        run: unfinished('blocked'),
        refused: true,
      });

      const outcome = unwrap(await implement());

      expect(outcome).toEqual({ kind: 'refused', paths: [workflow], url: github.comments[0].url });
      expect(receipts.state.refusals).toEqual({
        [`${key}@${revision}`]: { runId: id, revision, paths: [workflow] },
      });
      expect(github.commentsMade).toBe(1);
    });

    it('is inspected before a status comment recorded for its revision is reused', async () => {
      const { implement, github, id, receipts, revision, workflow } = setup({
        run: unfinished('blocked'),
        refused: true,
      });
      const identity = { runId: id, outcome: 'blocked' as const, revision };
      receipts.state = withComment(receipts.state, identity, faker.internet.url());

      expect(unwrap(await implement())).toMatchObject({ kind: 'refused', paths: [workflow] });
      expect(github.commentsMade).toBe(1);
    });
  });

  describe('a stuck run with commits', () => {
    it('is published as one draft PR with one findings comment, across reruns', async () => {
      const { implement, github, id, issue, receipts, runBranches, revision, feedback } = setup({
        run: stuckWithWork(),
      });

      const outcome = unwrap(await implement());

      const pr = github.pullRequests.get(runBranchFor(id));
      if (!pr) panic('The stuck run opened no PR');
      const [findings] = github.comments;
      expect(outcome).toEqual({
        kind: 'draftPullRequest',
        url: pr.url,
        reused: false,
        findingsUrl: findings.url,
      });
      expect(pr).toMatchObject({ draft: true, base: github.defaultBranch });
      expect(pr.body).toContain(`Closes #${issue.number}`);
      expect(github.comments.map(({ number }) => number)).toEqual([pr.number]);
      expect(findings.body).toContain(revision);
      expect(findings.body).toContain(feedback);
      expect(runBranches.published.get(id)).toBe(revision);
      expect(Object.values(receipts.state.findingsComments)).toEqual([findings.url]);
      expect(unwrap(await implement())).toEqual({ ...outcome, reused: true });
      expect(unwrap(await implement())).toEqual({ ...outcome, reused: true });
      expect(github.prsOpened).toBe(1);
      expect(github.commentsMade).toBe(1);
    });

    it('is retried after a refused PR with the same inspected revision', async () => {
      const { implement, github, id, runBranches, revision } = setup({ run: stuckWithWork() });
      const failure = aRefusal();
      github.failOnce('openPullRequest', failure);

      const failed = await implement();
      expect(failed.isErr() && failed.error).toBe(failure);

      expect(unwrap(await implement())).toMatchObject({ kind: 'draftPullRequest', reused: false });
      expect(runBranches.published.get(id)).toBe(revision);
      expect(github.prsOpened).toBe(1);
      expect(github.commentsMade).toBe(1);
    });

    it('gets its findings comment on a rerun after the draft opened but its comment failed', async () => {
      const { implement, github, receipts, key } = setup({ run: stuckWithWork() });
      github.failOnce('commentOnIssue', aRefusal());

      expect((await implement()).isErr()).toBe(true);
      const { url } = receipts.state.receipts[key];
      expect(receipts.state.findingsComments).toEqual({});

      expect(unwrap(await implement())).toEqual({
        kind: 'draftPullRequest',
        url,
        reused: true,
        findingsUrl: github.comments[0].url,
      });
      expect(github.prsOpened).toBe(1);
      expect(github.commentsMade).toBe(1);
    });

    it.each([
      [
        'its response was lost',
        ({ github }: Context) => github.failOnceAfterEffect('commentOnIssue', aLostResponse()),
      ],
      [
        'its receipt failed to save',
        ({ receipts }: Context) =>
          receipts.failOnceSaving(
            (next: Orchestration) => Object.keys(next.findingsComments).length > 0,
            new RemoteUnavailable({ message: faker.lorem.sentence() }),
          ),
      ],
    ])(
      'finds its findings comment posted when %s instead of posting it again',
      async (_, interrupt) => {
        const context = setup({ run: stuckWithWork() });
        const { implement, github, receipts } = context;
        interrupt(context);

        expect((await implement()).isErr()).toBe(true);
        expect(github.commentsMade).toBe(1);
        expect(receipts.state.findingsComments).toEqual({});

        const outcome = unwrap(await implement());
        expect(outcome).toMatchObject({
          kind: 'draftPullRequest',
          findingsUrl: github.comments[0].url,
        });
        expect(unwrap(await implement())).toEqual(outcome);
        expect(Object.values(receipts.state.findingsComments)).toEqual([github.comments[0].url]);
        expect(github.commentsMade).toBe(1);
        expect(github.prsOpened).toBe(1);
      },
    );

    it('gets the findings missing from a draft recorded before findings existed, past a status comment for the same revision', async () => {
      const { implement, github, id, receipts, key, revision } = setup({ run: stuckWithWork() });
      const legacy = { ...anOpenPullRequest(runBranchFor(id)), draft: true };
      github.pullRequests.set(legacy.head, legacy);
      receipts.state = withComment(
        withPullRequest(receipts.state, key, legacy),
        { runId: id, outcome: 'stuck', revision },
        faker.internet.url(),
      );

      expect(unwrap(await implement())).toEqual({
        kind: 'draftPullRequest',
        url: legacy.url,
        reused: true,
        findingsUrl: github.comments[0].url,
      });
      expect(github.comments.map(({ number }) => number)).toEqual([legacy.number]);
      expect(github.prsOpened).toBe(0);
    });

    it('is refused once, its lost comment recovered, without a draft, when it changes a workflow', async () => {
      const { implement, github, issue, runBranches, workflow } = setup({
        run: stuckWithWork(),
        refused: true,
      });
      github.failOnceAfterEffect('commentOnIssue', aLostResponse());

      expect((await implement()).isErr()).toBe(true);
      const outcome = unwrap(await implement());

      expect(outcome).toEqual({ kind: 'refused', paths: [workflow], url: github.comments[0].url });
      expect(unwrap(await implement())).toEqual(outcome);
      expect(github.comments.map(({ number }) => number)).toEqual([issue.number]);
      expect(github.prsOpened).toBe(0);
      expect(runBranches.published.size).toBe(0);
    });

    it('has a draft GitHub refuses explained when its commits change no files', async () => {
      const { implement, github, id, runBranches, revision } = setup({ run: stuckWithWork() });
      runBranches.changesFiles = false;
      const failure = aRefusal();
      github.failOnce('openPullRequest', failure);

      const result = await implement();

      if (!result.isErr()) panic('A refused draft PR was reported as published');
      expect(result.error).toBeInstanceOf(GithubRefused);
      expect(result.error.message).not.toBe(failure.message);
      expect(result.error.message).toContain(failure.message);
      expect(result.error.message).toContain(runBranchFor(id));
      expect(runBranches.published.get(id)).toBe(revision);
      expect(github.commentsMade).toBe(0);
    });

    it('keeps another failure to open its draft as it is, even when its commits change no files', async () => {
      const { implement, github, runBranches } = setup({ run: stuckWithWork() });
      runBranches.changesFiles = false;
      const failure = aLostResponse();
      github.failOnce('openPullRequest', failure);

      const result = await implement();

      expect(result.isErr() && result.error).toBe(failure);
    });
  });

  describe('publication ownership', () => {
    it('publishes nothing while another job owns the publication', async () => {
      const { implement, github, receipts, runBranches, key } = setup();
      const owner = { token: faker.string.uuid(), expiresAt: Date.now() + 60_000 };
      receipts.state = claimPublication(receipts.state, key, owner, Date.now());

      const result = await implement();

      expect(result.isErr() && result.error).toBeInstanceOf(PublicationInProgress);
      expect(runBranches.published.size).toBe(0);
      expect(github.prsOpened).toBe(0);
      expect(github.commentsMade).toBe(0);
      expect(receipts.state.owners[key]).toEqual(owner);
    });

    it.each([
      ['its code is pushed', {}, 'publish'],
      ['its PR is opened', {}, 'openPullRequest'],
      ['its comment is posted', { run: unfinished('stuck') }, 'commentOnIssue'],
    ] as const)('is renewed before %s', async (_, options, effect) => {
      const { implement, receipts, runBranches, github } = setup(options);
      const renew = vi.spyOn(receipts, 'renew').mockResolvedValue(Result.ok(false));
      if (effect === 'openPullRequest') renew.mockResolvedValueOnce(Result.ok(true));

      const result = await implement();

      expect(result.isErr() && result.error).toBeInstanceOf(PublicationInProgress);
      expect(runBranches.published.size).toBe(effect === 'openPullRequest' ? 1 : 0);
      expect(github.prsOpened).toBe(0);
      expect(github.commentsMade).toBe(0);
    });

    it('is released once the outcome is published', async () => {
      const { implement, receipts } = setup();

      unwrap(await implement());

      expect(receipts.state.owners).toEqual({});
    });
  });

  type Context = ReturnType<typeof setup>;

  function setup({
    run = {},
    settings,
    refused = false,
    environment,
    repositoryRoot = Result.ok(),
    config,
    presetSource = new InMemoryPresetSource(),
    pick,
  }: {
    /** How the saved run stands, completed with code unless told; `null` for an issue never run. */
    run?: Parameters<typeof aRunState>[0] | null;
    settings?: Partial<RunSettings>;
    refused?: boolean;
    environment?: Record<string, string>;
    repositoryRoot?: Result<void, RepositoryInvalid>;
    config?: object;
    presetSource?: InMemoryPresetSource;
    pick?: PresetPick;
  } = {}) {
    const cwd = faker.system.directoryPath();
    const github = new FakeGithub();
    const issue = anIssue();
    github.issues.set(issue.number, issue);
    const repositoryName = `${faker.string.alpha(10)}/${faker.string.alpha(10)}`;
    const key = `${repositoryName}#${issue.number}`;
    const id = runIdFor({ name: issue.title, key });
    const revision = faker.git.commitSha();
    const workflow = `.github/workflows/${faker.string.alpha(8)}.yml`;
    const feedback = faker.lorem.sentence();
    const store = new InMemoryRunStore();
    const runBranches = new FakeRunBranches();
    if (refused) runBranches.refusedPaths = [workflow];
    if (run) {
      const saved = aRunState({
        runId: id,
        phase: 'completed',
        merge: false,
        codePublication: 'deferred',
        request: requestText(issue),
        startingCommit: faker.git.commitSha(),
        codeRevision: revision,
        ...run,
        slices: (run.slices ?? []).map((slice) =>
          slice.status === 'stuck'
            ? { ...slice, rejectedReview: aRejectedReview({ feedback }) }
            : slice,
        ),
      });
      store.saved.push(saved);
      if (saved.codeRevision) runBranches.heads.set(id, saved.codeRevision);
    }
    const receipts = new InMemoryPublicationReceipts();
    const log = mock<RunLog>();
    const agentFailure = Result.err(new AgentRunFailed({ message: faker.lorem.sentence() }));
    const engineDependencies = {
      ports: {
        agent: mock<AgentSession>({
          run: vi.fn().mockResolvedValue(agentFailure),
          runForOutput: vi.fn().mockResolvedValue(agentFailure),
        }),
        workspace: mock<Workspace>(),
      },
      store,
      events: new RecordingEventSink(),
      clock: new SteppingClock(),
      settings: runSettings({ maxStepRetries: 0, ...settings }),
    };
    const sandbox = mock<RunSandbox>({
      checkCredentials: vi.fn(() =>
        run
          ? Result.ok()
          : Result.err(new SandboxCredentialsInvalid({ message: faker.lorem.sentence() })),
      ),
      ensureImage: vi.fn().mockResolvedValue(Result.ok()),
      startTelemetry: vi.fn().mockResolvedValue(undefined),
      openScope: vi.fn().mockResolvedValue(
        Result.ok({
          engineDependencies,
          closeSession: async () => Result.ok(),
          dispose: async () => undefined,
        }),
      ),
    });
    const storesNamed: string[] = [];
    let disposed = 0;
    const openRuntime = vi.fn((request: RuntimeRequest) => ({
      run: {
        config: { ...aJigConfig(), ...request.config },
        log,
        lockRun: async () => Result.ok(async () => undefined),
        runStores: {
          storeNamed: async (name: string) => {
            storesNamed.push(name);
            return Result.ok(store);
          },
          combined: () => store,
        },
        startingPoint: async () =>
          Result.ok({ baseBranch: github.defaultBranch, startingCommit: faker.git.commitSha() }),
        records: mock<InvocationRecords>({
          metricsSummary: vi.fn().mockReturnValue(Result.ok(aMetricsSummary())),
          recordInvocation: vi.fn().mockResolvedValue(Result.ok()),
        }),
        sandbox,
      },
      dispose: async () => {
        disposed++;
      },
    }));
    const githubFor = vi.fn(() => github);
    const originName = vi.fn<IssueCapabilities['githubOriginName']>(async () =>
      Result.ok(undefined),
    );
    const configSourceFor = vi.fn(() => new InMemoryConfigSource({ json: config ?? {} }));
    const capabilities: IssueCapabilities = {
      context: () => ({
        cwd,
        environment: environment ?? {
          GITHUB_TOKEN: faker.string.alphanumeric(20),
          GITHUB_REPOSITORY: repositoryName,
        },
        fallbackHomeDirectory: faker.system.directoryPath(),
      }),
      ensureRepositoryRoot: async () => repositoryRoot,
      readSavedCredentials: () => Result.ok({}),
      configSourceFor,
      presetSourceFor: () => presetSource,
      askForPreset: async () => pick,
      openRuntime,
      githubFor,
      githubOriginName: originName,
      publicationAt: () => ({ receipts, runBranches }),
    };
    return {
      cwd,
      github,
      githubFor,
      originName,
      openRuntime,
      configSourceFor,
      issue,
      key,
      id,
      revision,
      workflow,
      feedback,
      store,
      receipts,
      runBranches,
      storesNamed: () => storesNamed,
      disposed: () => disposed,
      loggedEvents: () => log.info.mock.calls.map(([details]) => details),
      implement: (preparation: Omit<RunPreparation, 'logFormat'> = {}) =>
        implementGithubIssue(capabilities, {
          ...preparation,
          issueNumber: issue.number,
          logFormat: 'json',
        }),
    };
  }
});

function aRefusal() {
  return new GithubRefused({ message: faker.lorem.sentence() });
}

function aLostResponse() {
  return new GithubUnavailable({ message: faker.lorem.sentence() });
}

function anOpenPullRequest(head: string) {
  return {
    number: faker.number.int({ min: 20_001, max: 30_000 }),
    url: faker.internet.url(),
    head,
    base: 'main',
    title: faker.lorem.sentence(),
    body: faker.lorem.paragraph(),
    draft: false,
  };
}

/** A run with a checkpoint and nothing committed past where it started. */
function unfinished(status: 'blocked' | 'stuck') {
  const startingCommit = faker.git.commitSha();
  const slices = [aSlice({ status: 'stuck' })];
  return status === 'stuck'
    ? { phase: 'stuck' as const, startingCommit, codeRevision: startingCommit, slices }
    : { phase: 'context' as const };
}

function stuckWithWork() {
  return { phase: 'stuck' as const, slices: [aSlice({ status: 'stuck' })] };
}
