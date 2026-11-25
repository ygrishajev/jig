import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aMetricsSummary,
  aRevisionAwaitingReReview,
  aRunState,
  designDocs,
} from '../../tests/support/builders.js';
import { designReviewReport } from '../domain/design-review-report.js';
import { runDocumentContents } from './run-documents.js';
import { formatSummary } from './run-summary.js';

describe('runDocumentContents', () => {
  it('hands over the design and plan as the run holds them', () => {
    const docs = designDocs();

    const documents = runDocumentContents(aRunState({ docs }), aMetricsSummary());

    expect(documents['design.md']).toBe(docs.design);
    expect(documents['plan.md']).toBe(docs.plan);
  });

  it('reports a design review in progress', () => {
    const state = aRunState({
      phase: 'reviewingDesign',
      designReview: aRevisionAwaitingReReview(),
    });

    const documents = runDocumentContents(state, aMetricsSummary());

    expect(documents['design-review.md']).toBe(designReviewReport(state));
  });

  it('closes the pull request description with a footer naming the run and its totals so far', () => {
    const prDescription = faker.lorem.paragraphs();
    const metrics = aMetricsSummary();
    const state = aRunState({ prDescription });

    const description = runDocumentContents(state, metrics)['PR_DESCRIPTION.md'];

    expect(description).toBe(
      `${prDescription}\n\n---\n<sub>jig run ${state.runId}: ${formatSummary(metrics)}</sub>\n`,
    );
  });

  it('leaves out every document the run does not have yet', () => {
    const documents = runDocumentContents(
      aRunState({ docs: undefined, prDescription: undefined, designReview: undefined }),
      aMetricsSummary(),
    );

    expect(documents).toEqual({
      'design.md': undefined,
      'plan.md': undefined,
      'design-review.md': undefined,
      'PR_DESCRIPTION.md': undefined,
    });
  });
});
