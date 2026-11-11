import {
  type DesignFinding,
  type DesignReview,
  type DesignReviewProgress,
  type DesignReviewStage,
  designReviewStage,
  type FindingDisposition,
  MAX_DESIGN_REVIEWS,
  outstandingFindings,
} from './design-review.js';
import type { RunState } from './run-state.js';

/** Built from the saved run alone, so a run resumed on another machine explains itself without local reports. */
export function designReviewReport(state: RunState): string | undefined {
  const stage = designReviewStage(state);
  if (stage === undefined) return undefined;
  const progress = state.designReview;
  return [
    '# Design review',
    `**Status:** ${STAGE_DESCRIPTIONS[stage]}`,
    `**Reviews:** ${progress?.reviews.length ?? 0} of ${MAX_DESIGN_REVIEWS}`,
    ...(progress ? progressSections(progress) : []),
  ]
    .join('\n\n')
    .concat('\n');
}

const STAGE_DESCRIPTIONS: Record<DesignReviewStage, string> = {
  awaitingReview: 'pending — the design has not been reviewed yet.',
  awaitingRevision: "pending — the review found problems; the planner's revision is next.",
  awaitingReReview: 'pending — the planner revised the design; the re-review is next.',
  approved: 'approved — the latest review left no findings standing.',
  unresolved:
    "blocked — findings still stand after the planner's one revision; the run needs a person.",
};

function progressSections(progress: DesignReviewProgress): string[] {
  const [firstReview, reReview] = progress.reviews;
  return [
    ...operatorDecisionSection(outstandingFindings(progress)),
    ...reviewSection('Review 1', firstReview),
    ...(progress.revision ? revisionSection(progress.revision) : []),
    ...(reReview ? reviewSection('Review 2', reReview) : []),
  ];
}

function operatorDecisionSection(outstanding: readonly DesignFinding[]): string[] {
  const decisions = outstanding.filter((finding) => finding.resolution === 'operatorDecision');
  if (decisions.length === 0) return [];
  return [
    '## Decisions for the operator',
    decisions
      .map(
        (finding) =>
          `- **${finding.id}**: ${finding.concern} Recommended: ${finding.recommendation}`,
      )
      .join('\n'),
  ];
}

function reviewSection(heading: string, review: DesignReview): string[] {
  if (review.findings.length === 0) return [`## ${heading}`, 'No consequential findings.'];
  return [`## ${heading}`, ...review.findings.map(findingSection)];
}

function findingSection(finding: DesignFinding): string {
  return [
    `### ${finding.id}: ${finding.concern}`,
    `- **Needs:** ${RESOLUTION_DESCRIPTIONS[finding.resolution]}`,
    `- **Failure scenario:** ${finding.failureScenario}`,
    `- **Evidence:**\n${indentedList(finding.evidence)}`,
    `- **Recommendation:** ${finding.recommendation}`,
    ...(finding.uncertainty ? [`- **Uncertainty:** ${finding.uncertainty}`] : []),
  ].join('\n');
}

const RESOLUTION_DESCRIPTIONS: Record<DesignFinding['resolution'], string> = {
  correction: 'a technical correction',
  operatorDecision: 'an operator decision',
};

function indentedList(items: readonly string[]): string {
  return items.map((item) => `  - ${item}`).join('\n');
}

function revisionSection(revision: NonNullable<DesignReviewProgress['revision']>): string[] {
  return [
    '## Revision',
    revision.dispositions.map(dispositionLine).join('\n'),
    originalDocument('Design as first reviewed', revision.reviewedDocs.design),
    originalDocument('Plan as first reviewed', revision.reviewedDocs.plan),
  ];
}

function dispositionLine(disposition: FindingDisposition): string {
  if (disposition.status === 'addressed') {
    return `- **${disposition.findingId}** addressed: ${disposition.change}`;
  }
  return [
    `- **${disposition.findingId}** disputed: ${disposition.reasoning}`,
    indentedList(disposition.evidence),
  ].join('\n');
}

/** The pre-revision document, folded away: `design.md` and `plan.md` hold the current ones. */
function originalDocument(summary: string, markdown: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${markdown}\n\n</details>`;
}
