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
} from '../../tests/support/builders.js';
import {
  completionEvidenceOf,
  completionEvidenceSchema,
  completionStillReusable,
  settingsIdentityOf,
  wholeRequestOf,
} from './completion-reuse.js';
import type { FulfillmentVerdict } from './final-check.js';
import { runStateSchema } from './run-state.js';
import type { WorkFacts } from './work-facts.js';

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
  it('binds the evidence to the resulting work, the sources it judged and the settings it ran under', () => {
    const request = `# ${faker.lorem.sentence()}`;
    const docs = designDocs();
    const settings = runSettings({ verifyCommand: `npm run ${faker.word.verb()}` });
    const work = workFacts();
    const range = `${faker.git.commitSha()}..${work.host.commit}`;
    const verdict: FulfillmentVerdict = { fulfilled: false, gaps: [faker.lorem.sentence()] };

    const evidence = completionEvidenceOf({
      reviewed: { request, plan: docs.plan },
      settings,
      command: settings.verifyCommand,
      verdict,
      observed: { before: work, after: work },
      range,
    });

    expect(evidence).toEqual({
      verdict,
      command: settings.verifyCommand,
      settingsIdentity: settingsIdentityOf(settings),
      checked: { commit: work.host.commit, tree: work.host.tree },
      observed: { before: work, after: work },
      scope: { request: digestOf(request), plan: digestOf(docs.plan), range },
    });
  });

  it('records no command when the run records no verification', () => {
    const request = `# ${faker.lorem.sentence()}`;
    const work = workFacts();

    const evidence = completionEvidenceOf({
      reviewed: { request, plan: designDocs().plan },
      settings: runSettings(),
      command: undefined,
      verdict: { fulfilled: true, gaps: [] },
      observed: { before: work, after: work },
      range: `${faker.git.commitSha()}..${work.host.commit}`,
    });

    expect(evidence.command).toBeUndefined();
  });
});

describe('completionEvidenceSchema', () => {
  it('survives a save and load round trip', () => {
    const evidence = completionEvidenceOf({
      reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
      settings: runSettings(),
      command: undefined,
      verdict: { fulfilled: true, gaps: [] },
      observed: { before: workFacts(), after: workFacts() },
      range: `${faker.git.commitSha()}..HEAD`,
    });

    expect(completionEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
  });

  it('rides along in a saved run the store loads back', () => {
    const state = aRunState({
      phase: 'slices',
      slices: [aSlice({ status: 'in_review' })],
      completionReuse: completionEvidenceOf({
        reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
        settings: runSettings(),
        command: undefined,
        verdict: { fulfilled: true, gaps: [] },
        observed: { before: workFacts(), after: workFacts() },
        range: `${faker.git.commitSha()}..HEAD`,
      }),
    });

    expect(runStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('refuses a record whose settings identity is not a digest', () => {
    const evidence = completionEvidenceOf({
      reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
      settings: runSettings(),
      command: undefined,
      verdict: { fulfilled: true, gaps: [] },
      observed: { before: workFacts(), after: workFacts() },
      range: `${faker.git.commitSha()}..HEAD`,
    });

    expect(
      completionEvidenceSchema.safeParse({ ...evidence, settingsIdentity: 'not-a-digest' }).success,
    ).toBe(false);
  });
});

describe('completionStillReusable', () => {
  it('stands while the work, sources, settings and verdict it recorded all hold', () => {
    const { state, settings, observed } = setupReused();

    expect(completionStillReusable(state, observed, settings)).toBe(true);
  });

  it('falls when the review approved the code without finding the request fulfilled', () => {
    const { state, settings, observed } = setupReused({
      verdict: { fulfilled: false, gaps: [] },
    });

    expect(completionStillReusable(state, observed, settings)).toBe(false);
  });

  it('falls when the review left explicit gaps, fulfilled or not', () => {
    const { state, settings, observed } = setupReused({
      verdict: { fulfilled: true, gaps: [faker.lorem.sentence()] },
    });

    expect(completionStillReusable(state, observed, settings)).toBe(false);
  });

  it('falls when the settings changed since the review ran', () => {
    const { state, observed } = setupReused();

    expect(
      completionStillReusable(state, observed, runSettings({ verifyCommand: 'npm test' })),
    ).toBe(false);
  });

  it('falls when the run branch moved on to other work', () => {
    const { state, settings, observed } = setupReused();
    const movedOn = {
      host: { ...observed.host, commit: faker.git.commitSha(), tree: faker.git.commitSha() },
      sandbox: observed.sandbox,
    };

    expect(completionStillReusable(state, movedOn, settings)).toBe(false);
  });

  it('falls when the host worktree is left dirty', () => {
    const { state, settings, observed } = setupReused();
    const dirtyHost = { ...observed, host: { ...observed.host, clean: false } };

    expect(completionStillReusable(state, dirtyHost, settings)).toBe(false);
  });

  it('falls when the sandbox is left dirty, even at the commit the review checked', () => {
    const { state, settings, observed } = setupReused();
    const dirtySandbox = {
      ...observed,
      sandbox: { ...observed.sandbox, clean: false },
    };

    expect(completionStillReusable(state, dirtySandbox, settings)).toBe(false);
  });

  it('falls when the work changed while the review itself ran', () => {
    const before = coherentWork();
    const after = {
      host: before.host,
      sandbox: gitFacts({ commit: faker.git.commitSha() }),
    };
    const settings = runSettings();
    const state = aRunState({
      phase: 'slices',
      slices: [aSlice()],
      completionReuse: completionEvidenceOf({
        reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
        settings,
        command: undefined,
        verdict: { fulfilled: true, gaps: [] },
        observed: { before, after },
        range: `${faker.git.commitSha()}..${after.host.commit}`,
      }),
    });

    expect(completionStillReusable(state, before, settings)).toBe(false);
  });

  it('falls when the review ran on work that was already dirty', () => {
    const clean = coherentWork();
    const dirty = { host: { ...clean.host, clean: false }, sandbox: clean.sandbox };
    const settings = runSettings();
    const state = aRunState({
      phase: 'slices',
      slices: [aSlice()],
      completionReuse: completionEvidenceOf({
        reviewed: { request: faker.lorem.paragraph(), plan: designDocs().plan },
        settings,
        command: undefined,
        verdict: { fulfilled: true, gaps: [] },
        observed: { before: dirty, after: dirty },
        range: `${faker.git.commitSha()}..${dirty.host.commit}`,
      }),
    });

    expect(completionStillReusable(state, dirty, settings)).toBe(false);
  });

  it('falls when the sources it judged have changed since the review', () => {
    const { state, settings, observed } = setupReused();
    const editedPlan = { ...state, docs: designDocs() } satisfies typeof state;

    expect(completionStillReusable(editedPlan, observed, settings)).toBe(false);
  });

  it('falls when nothing was ever recorded', () => {
    const state = aRunState({ phase: 'slices', slices: [aSlice()] });

    expect(completionStillReusable(state, coherentWork(), runSettings())).toBe(false);
  });

  function setupReused(input: { verdict?: FulfillmentVerdict } = {}) {
    const request = `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    const docs = designDocs();
    const settings = runSettings();
    const observed = coherentWork();
    const state = aRunState({
      phase: 'slices',
      request,
      docs,
      slices: [aSlice({ status: 'in_review' })],
      completionReuse: completionEvidenceOf({
        reviewed: { request, plan: docs.plan },
        settings,
        command: settings.verifyCommand,
        verdict: input.verdict ?? { fulfilled: true, gaps: [] },
        observed: { before: observed, after: observed },
        range: `${faker.git.commitSha()}..${observed.host.commit}`,
      }),
    });
    return { state, settings, observed };
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
