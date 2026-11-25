import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aRunState, runId } from '../../tests/support/builders.js';
import { runBranchFor } from '../domain/run-state.js';
import { pullRequestFor, refusalCommentBody, statusCommentBody } from './publication-content.js';

describe('publication content', () => {
  it('offers the run branch against its base with the bare description, closing the issue', () => {
    const state = aRunState({
      baseBranch: faker.git.branch(),
      prDescription: faker.lorem.paragraph(),
    });
    const issueNumber = faker.number.int({ min: 1, max: 1000 });
    const title = faker.lorem.sentence();
    const draft = faker.datatype.boolean();

    const pullRequest = pullRequestFor(
      { state, status: 'completed' },
      { title, issueNumber, draft },
    );

    expect(pullRequest).toStrictEqual({
      head: runBranchFor(state.runId),
      base: state.baseBranch,
      title,
      body: `${state.prDescription}\n\nCloses #${issueNumber}`,
      draft,
    });
  });

  it('gives a blocked run the reason it blocked', () => {
    const reason = faker.lorem.sentence();

    const body = statusCommentBody({ state: aRunState(), status: 'blocked', reason });

    expect(body).toContain(reason);
  });

  it('names the run, the refused revision and every refused path', () => {
    const refusal = {
      runId: runId(),
      revision: faker.git.commitSha(),
      paths: faker.helpers.uniqueArray(() => `.github/workflows/${faker.lorem.slug()}.yml`, 3),
    };

    const body = refusalCommentBody(refusal);

    for (const value of [refusal.runId, refusal.revision, ...refusal.paths])
      expect(body).toContain(value);
  });
});
