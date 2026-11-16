import { faker } from '@faker-js/faker';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  aFinalCheckResult,
  aRunState,
  aSlice,
  designDocs,
  gitFacts,
  runSettings,
  workFacts,
  workObservations,
} from '../../tests/support/builders.js';
import {
  type CompletionEvidence,
  completionEvidenceOf,
  completionEvidenceSchema,
  completionStillReusable,
  settingsIdentityOf,
  wholeRequestOf,
} from './completion-reuse.js';
import type { FulfillmentVerdict } from './final-check.js';
import type { FinalCheckResult } from './run-state.js';
import { runStateSchema } from './run-state.js';
import type { RunSettings } from './settings.js';
import type { Slice } from './slice.js';
import type { WorkFacts, WorkObservations } from './work-facts.js';

describe('wholeRequestOf', () => {
  it('gives the request and the plan of a run whose single slice is its whole work', () => {
    const request = `# ${faker.lorem.sentence()}`;
    const docs = designDocs();
    const state = aRunState({ phase: 'slices', request, docs, slices: [aSlice()] });

    expect(wholeRequestOf(state)).toEqual({ request, plan: docs.plan });
  });

  it('refuses a run with more than one slice, however far its other slices are', () => {
    const state = aRunState({
      phase: 'slices',
      slices: [aSlice({ order: 0, status: 'approved' }), aSlice({ order: 1 })],
    });

    expect(wholeRequestOf(state)).toBeUndefined();
  });

  it('refuses a run whose final check already ran, so a repair is never reviewed as the whole request', () => {
    const state = aRunState({
      phase: 'slices',
      finalCheck: aFinalCheckResult(),
      slices: [aSlice()],
    });

    expect(wholeRequestOf(state)).toBeUndefined();
  });

  it('refuses a run the plan never reached, leaving its review an ordinary one', () => {
    const state = aRunState({ phase: 'context', slices: [aSlice()] });

    expect(wholeRequestOf(state)).toBeUndefined();
  });
});

describe('completionEvidenceOf', () => {
  it('binds the evidence to the resulting work, the verification it passed, the sources it judged and the settings it ran under', () => {
    const request = `# ${faker.lorem.sentence()}`;
    const docs = designDocs();
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const settings = runSettings({ verifyCommand });
    const work = workFacts();
    const verification = { command: verifyCommand, observed: workObservations() };
    const range = { start: faker.git.commitSha(), end: work.host.commit };
    const verdict: FulfillmentVerdict = { fulfilled: false, gaps: [faker.lorem.sentence()] };

    const evidence = completionEvidenceOf({
      reviewed: { request, plan: docs.plan },
      settings,
      verification,
      verdict,
      observed: { before: work, after: work },
      range,
    });

    expect(evidence).toEqual({
      verdict,
      verification,
      settingsIdentity: settingsIdentityOf(settings),
      checked: { commit: work.host.commit, tree: work.host.tree },
      observed: { before: work, after: work },
      scope: { request: digestOf(request), plan: digestOf(docs.plan), range },
    });
  });

  it('records no verification when the run records none', () => {
    const work = workFacts();

    const evidence = completionEvidenceOf({
      reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
      settings: runSettings(),
      verification: undefined,
      verdict: { fulfilled: true, gaps: [] },
      observed: { before: work, after: work },
      range: { start: faker.git.commitSha(), end: work.host.commit },
    });

    expect(evidence.verification).toBeUndefined();
  });
});

describe('completionEvidenceSchema', () => {
  it('survives a save and load round trip', () => {
    const evidence = completionEvidenceOf({
      reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
      settings: runSettings({ verifyCommand: 'npm test' }),
      verification: { command: 'npm test', observed: workObservations() },
      verdict: { fulfilled: true, gaps: [] },
      observed: { before: workFacts(), after: workFacts() },
      range: { start: faker.git.commitSha(), end: faker.git.commitSha() },
    });

    expect(completionEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  });

  it('parses a verification record saved before observations were recorded', () => {
    const evidence = completionEvidenceOf({
      reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
      settings: runSettings({ verifyCommand: 'npm test' }),
      verification: { command: 'npm test' },
      verdict: { fulfilled: true, gaps: [] },
      observed: { before: workFacts(), after: workFacts() },
      range: { start: faker.git.commitSha(), end: faker.git.commitSha() },
    });

    expect(completionEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  });

  it('rides along in a saved run the store loads back', () => {
    const state = aRunState({
      phase: 'slices',
      slices: [aSlice({ status: 'in_review' })],
      completionReuse: completionEvidenceOf({
        reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
        settings: runSettings({ verifyCommand: 'npm test' }),
        verification: { command: 'npm test', observed: workObservations() },
        verdict: { fulfilled: true, gaps: [] },
        observed: { before: workFacts(), after: workFacts() },
        range: { start: faker.git.commitSha(), end: faker.git.commitSha() },
      }),
    });

    expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('refuses a record whose settings identity is not a digest', () => {
    const evidence = aRecordedEvidence();

    expect(
      completionEvidenceSchema.safeParse({ ...evidence, settingsIdentity: 'not-a-digest' }).success,
    ).toBe(false);
  });

  it('refuses a record that names no run range', () => {
    const evidence = aRecordedEvidence();

    expect(
      completionEvidenceSchema.safeParse({
        ...evidence,
        scope: { request: evidence.scope.request, plan: evidence.scope.plan },
      }).success,
    ).toBe(false);
  });

  function aRecordedEvidence(): CompletionEvidence {
    return completionEvidenceOf({
      reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
      settings: runSettings(),
      verification: undefined,
      verdict: { fulfilled: true, gaps: [] },
      observed: { before: workFacts(), after: workFacts() },
      range: { start: faker.git.commitSha(), end: faker.git.commitSha() },
    });
  }
});

describe('completionStillReusable', () => {
  it('stands while the eligibility, verdict, verification, work, sources, settings and scope it recorded all hold', () => {
    const { state, settings, observed, forkPoint } = setup();

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(true);
  });

  it('falls when the review approved the code without finding the request fulfilled', () => {
    const { state, settings, observed, forkPoint } = setup({
      verdict: { fulfilled: false, gaps: [] },
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the review left explicit gaps, fulfilled or not', () => {
    const { state, settings, observed, forkPoint } = setup({
      verdict: { fulfilled: true, gaps: [faker.lorem.sentence()] },
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the settings changed since the review ran', () => {
    const { state, observed, forkPoint } = setup();

    expect(
      completionStillReusable(
        state,
        observed,
        runSettings({ verifyCommand: 'npm test' }),
        forkPoint,
      ),
    ).toBe(false);
  });

  it('falls when the review recorded no verification, however well everything else holds', () => {
    const { state, observed, forkPoint } = setup({ settings: runSettings() });

    expect(completionStillReusable(state, observed, runSettings(), forkPoint)).toBe(false);
  });

  it('falls when the recorded verification ran a command other than the one now configured', () => {
    const work = coherentWork();
    const { state, settings, observed, forkPoint } = setup({
      work,
      verification: { command: 'npm test', observed: { before: work, after: work } },
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the recorded verification predates recorded observations', () => {
    const { state, settings, observed, forkPoint } = setup({
      settings: runSettings({ verifyCommand: 'npm test' }),
      verification: { command: 'npm test' },
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the work moved while the verify command ran', () => {
    const work = coherentWork();
    const { state, settings, observed, forkPoint } = setup({
      work,
      verificationObserved: { before: work, after: coherentWork() },
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the verification passed on work other than the review checked', () => {
    const work = coherentWork();
    const verifiedElsewhere = coherentWork();
    const { state, settings, observed, forkPoint } = setup({
      work,
      verificationObserved: { before: verifiedElsewhere, after: verifiedElsewhere },
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the sandbox stood elsewhere than the host while the review ran, even once it later converges', () => {
    const work = coherentWork();
    const divergent = { host: work.host, sandbox: gitFacts() };
    const { state, settings, forkPoint } = setup({
      work,
      observed: { before: divergent, after: divergent },
    });

    expect(completionStillReusable(state, divergent, settings, forkPoint)).toBe(false);
    expect(completionStillReusable(state, work, settings, forkPoint)).toBe(false);
  });

  it('falls when the run branch moved on to other work', () => {
    const { state, settings, observed, forkPoint } = setup();
    const movedOn = {
      host: { ...observed.host, commit: faker.git.commitSha(), tree: faker.git.commitSha() },
      sandbox: observed.sandbox,
    };

    expect(completionStillReusable(state, movedOn, settings, forkPoint)).toBe(false);
  });

  it('falls when the host worktree is left dirty', () => {
    const { state, settings, observed, forkPoint } = setup();
    const dirtyHost = { ...observed, host: { ...observed.host, clean: false } };

    expect(completionStillReusable(state, dirtyHost, settings, forkPoint)).toBe(false);
  });

  it('falls when the sandbox is left dirty, even at the commit the review checked', () => {
    const { state, settings, observed, forkPoint } = setup();
    const dirtySandbox = {
      ...observed,
      sandbox: { ...observed.sandbox, clean: false },
    };

    expect(completionStillReusable(state, dirtySandbox, settings, forkPoint)).toBe(false);
  });

  it('falls when the sandbox holds the checked commit under another tree', () => {
    const { state, settings, observed, forkPoint } = setup();
    const otherTree = {
      ...observed,
      sandbox: { ...observed.sandbox, tree: faker.git.commitSha() },
    };

    expect(completionStillReusable(state, otherTree, settings, forkPoint)).toBe(false);
  });

  it('falls when the work changed while the review itself ran', () => {
    const work = coherentWork();
    const mutated = { host: work.host, sandbox: gitFacts() };
    const { state, settings, observed, forkPoint } = setup({
      work,
      observed: { before: work, after: mutated },
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the review ran on work that was already dirty', () => {
    const work = coherentWork();
    const dirty = { host: { ...work.host, clean: false }, sandbox: work.sandbox };
    const { state, settings, forkPoint } = setup({
      work,
      observed: { before: dirty, after: dirty },
    });

    expect(completionStillReusable(state, work, settings, forkPoint)).toBe(false);
  });

  it('falls when the review recorded a fulfilled request but the code stood rejected', () => {
    const { state, settings, observed, forkPoint } = setup({ slice: { status: 'in_review' } });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when a final check already ran, so a repair round can never reuse earlier evidence', () => {
    const { state, settings, observed, forkPoint } = setup({ finalCheck: aFinalCheckResult() });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the run grew a further slice after the review', () => {
    const { state, settings, observed, forkPoint } = setup({
      slices: [aSlice({ order: 0, status: 'approved' }), aSlice({ order: 1 })],
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the recorded range starts after the run was cut', () => {
    const { state, settings, observed } = setup();

    expect(completionStillReusable(state, observed, settings, faker.git.commitSha())).toBe(false);
  });

  it('falls when the recorded range does not end at the work the review checked', () => {
    const { state, settings, observed, forkPoint } = setup({
      rangeEnd: faker.git.commitSha(),
    });

    expect(completionStillReusable(state, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when the sources it judged have changed since the review', () => {
    const { state, settings, observed, forkPoint } = setup();
    const editedPlan = { ...state, docs: designDocs() } satisfies typeof state;

    expect(completionStillReusable(editedPlan, observed, settings, forkPoint)).toBe(false);
  });

  it('falls when nothing was ever recorded', () => {
    const state = aRunState({ phase: 'slices', slices: [aSlice()] });

    expect(
      completionStillReusable(state, coherentWork(), runSettings(), faker.git.commitSha()),
    ).toBe(false);
  });

  function setup(
    input: {
      verdict?: FulfillmentVerdict;
      verification?: CompletionEvidence['verification'];
      verificationObserved?: WorkObservations;
      observed?: WorkObservations;
      work?: WorkFacts;
      slice?: Partial<Slice>;
      slices?: Slice[];
      finalCheck?: FinalCheckResult;
      settings?: RunSettings;
      forkPoint?: string;
      rangeEnd?: string;
    } = {},
  ) {
    const request = `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    const docs = designDocs();
    const settings =
      input.settings ?? runSettings({ verifyCommand: `npm run ${faker.word.verb()}` });
    const work = input.work ?? coherentWork();
    const observed = input.observed ?? { before: work, after: work };
    const forkPoint = input.forkPoint ?? faker.git.commitSha();
    const verification =
      input.verification ??
      (settings.verifyCommand
        ? {
            command: settings.verifyCommand,
            observed: input.verificationObserved ?? { before: work, after: work },
          }
        : undefined);
    const state = aRunState({
      phase: 'slices',
      request,
      docs,
      finalCheck: input.finalCheck,
      slices: input.slices ?? [aSlice({ status: 'approved', verification, ...input.slice })],
      completionReuse: completionEvidenceOf({
        reviewed: { request, plan: docs.plan },
        settings,
        verification,
        verdict: input.verdict ?? { fulfilled: true, gaps: [] },
        observed,
        range: { start: forkPoint, end: input.rangeEnd ?? observed.after.host.commit },
      }),
    });
    return { state, settings, observed: work, forkPoint };
  }
});

/** Where a run's work really stands after an import: the host and its sandbox clone at the same commit. */
function coherentWork(): WorkFacts {
  const shared = gitFacts();
  return workFacts({ host: shared, sandbox: shared });
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
