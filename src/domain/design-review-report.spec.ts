import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aDesignFinding,
  aDisposition,
  aFirstDesignReview,
  aRevisedDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
  designDocs,
} from '../../tests/support/builders.js';
import type { DesignFinding, DesignReviewProgress } from './design-review.js';
import { designReviewReport } from './design-review-report.js';
import type { RunPhase } from './run-state.js';

describe('designReviewReport', () => {
  it('leaves no report for a run without a design review', () => {
    expect(designReviewReport(aRunState({ phase: 'designing' }))).toBeUndefined();
    expect(designReviewReport(aRunState({ phase: 'slices' }))).toBeUndefined();
  });

  it('gives each stage its own status, and none of the pending ones reads as approved', () => {
    const { reportFor } = setup();
    const approved = statusOf(reportFor('slicing', { reviews: [{ findings: [] }] }));
    const others = [
      statusOf(reportFor('reviewingDesign')),
      statusOf(reportFor('revisingDesign', aFirstDesignReview())),
      statusOf(reportFor('reviewingDesign', aRevisionAwaitingReReview())),
      statusOf(reportFor('resolvingDesign', aRevisedDesignReview())),
    ];

    expect(new Set([approved, ...others]).size).toBe(5);
    expect(statusOf(reportFor('slicing', aRevisedDesignReview({ outstanding: [] })))).toBe(
      approved,
    );
  });

  it("carries both reviews' evidence and uncertainty, and the planner's dispositions", () => {
    const { reportFor } = setup();
    const first = [aFindingWithUncertainty(), aFindingWithUncertainty()];
    const second = [aFindingWithUncertainty()];
    const dispositions = [aDisposition(first[0], 'addressed'), aDisposition(first[1], 'disputed')];
    const progress: DesignReviewProgress = {
      reviews: [{ findings: first }, { findings: second }],
      revision: { reviewedDocs: designDocs(), dispositions },
    };

    const report = reportFor('resolvingDesign', progress);

    for (const finding of [...first, ...second]) {
      expect(report).toContain(finding.failureScenario);
      expect(report).toContain(finding.recommendation);
      expect(report).toContain(finding.uncertainty);
      for (const evidence of finding.evidence) expect(report).toContain(evidence);
    }
    for (const disposition of dispositions) {
      if (disposition.status === 'addressed') expect(report).toContain(disposition.change);
      else {
        expect(report).toContain(disposition.reasoning);
        for (const evidence of disposition.evidence) expect(report).toContain(evidence);
      }
    }
  });

  it('keeps the documents the revision replaced, while the run carries the revised ones', () => {
    const reviewedDocs = designDocs();
    const designReview = aRevisionAwaitingReReview({ reviewedDocs });
    const state = aRunState({ phase: 'reviewingDesign', designReview });

    const report = designReviewReport(state);

    expect(report).toContain(reviewedDocs.design);
    expect(report).toContain(reviewedDocs.plan);
    expect(report).not.toContain(state.docs?.design);
  });

  it('calls out an outstanding operator decision on top of its finding, but not a correction', () => {
    const { reportFor } = setup();
    const decision = aDesignFinding({ resolution: 'operatorDecision' });
    const correction = aDesignFinding({ resolution: 'correction' });

    const report = reportFor(
      'resolvingDesign',
      aRevisedDesignReview({ outstanding: [decision, correction] }),
    );

    expect(occurrencesOf(decision.id, report)).toBe(2);
    expect(occurrencesOf(correction.id, report)).toBe(1);
  });

  it('asks the operator for nothing once the re-review approves the design', () => {
    const { reportFor } = setup();
    const decision = aDesignFinding({ resolution: 'operatorDecision' });
    const progress: DesignReviewProgress = {
      reviews: [{ findings: [decision] }, { findings: [] }],
      revision: { reviewedDocs: designDocs(), dispositions: [aDisposition(decision)] },
    };

    const report = reportFor('slicing', progress);

    expect(occurrencesOf(decision.id, report)).toBe(2);
    expect(statusOf(report)).toBe(statusOf(reportFor('slicing', { reviews: [{ findings: [] }] })));
  });

  function setup() {
    const reportFor = (phase: RunPhase, designReview?: DesignReviewProgress) =>
      designReviewReport(aRunState({ phase, designReview })) ?? '';
    return { reportFor };
  }
});

function aFindingWithUncertainty(): DesignFinding {
  return aDesignFinding({ uncertainty: faker.lorem.sentence() });
}

/** The status is the paragraph under the report's title. */
function statusOf(report: string): string | undefined {
  return report.split('\n\n')[1];
}

function occurrencesOf(text: string, report: string): number {
  return report.split(text).length - 1;
}
