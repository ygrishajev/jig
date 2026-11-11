import type { DesignDocs } from '../domain/design-docs.js';
import type { DesignFinding, DesignReReview, FindingDisposition } from '../domain/design-review.js';
import type { FeaturePlan } from '../domain/run-state.js';

/** What every design-review prompt carries: the run's original inputs and the documents at stake. */
export interface DesignInputs {
  request: string;
  repoSummary: string;
  plan: FeaturePlan;
  docs: DesignDocs;
}

export function designReviewPrompt(inputs: DesignInputs): string {
  return [
    'You are the design review of an automated SDLC pipeline. A planner wrote the design and',
    'implementation plan below for the request below. Nothing has been implemented yet: decide',
    'whether this design and plan satisfy the request and hold up against this repository',
    'before the plan is broken into slices and built.',
    '',
    ...originalInputs(inputs),
    ...documentsSection('DESIGN UNDER REVIEW', inputs.docs),
    ...reviewRules(),
    ...findingFormat(),
  ].join('\n');
}

function originalInputs({ request, repoSummary, plan }: DesignInputs): string[] {
  return [
    '--- REQUEST START ---',
    request,
    '--- REQUEST END ---',
    '',
    '--- REPOSITORY CONTEXT ---',
    repoSummary,
    '',
    '--- FEATURE PLAN ---',
    `Summary: ${plan.summary}`,
    `Approach: ${plan.approach}`,
    `Affected areas: ${plan.affectedAreas.join(', ')}`,
    '',
  ];
}

function documentsSection(label: string, docs: DesignDocs): string[] {
  return [
    `--- ${label}: DESIGN START ---`,
    docs.design,
    `--- ${label}: DESIGN END ---`,
    '',
    `--- ${label}: IMPLEMENTATION PLAN START ---`,
    docs.plan,
    `--- ${label}: IMPLEMENTATION PLAN END ---`,
    '',
  ];
}

function reviewRules(): string[] {
  return [
    'Explore the repository as much as you need to check the documents against it.',
    '',
    'Raise a finding only for a consequential decision: one that, wrong or missing, would',
    'materially change behaviour the request requires, violate a constraint of this repository',
    '(its rules, conventions or existing design), or cause costly rework. Look for requirements',
    'the documents miss as well as choices they get wrong. Do not raise stylistic preferences,',
    'naming taste, speculative future needs, or improvements the request did not ask for.',
    '',
    'Every finding needs actionable evidence: quote or cite the request, or name the file and',
    'what it shows. Investigate a fact you are unsure of in the repository before relying on it.',
    'When doubt remains, say exactly what you could not confirm under "uncertainty"; never',
    'invent evidence. Give each finding an id unique within your reply.',
    '',
    'Mark a finding "correction" when the planner can settle it technically within the request,',
    'and "operatorDecision" when settling it needs a choice only the person who wrote the request',
    'can make — conflicting requirements, a product preference, or scope the request leaves open.',
    ...intentBoundaries(),
    ...noRepositoryChanges(),
    '',
  ];
}

function intentBoundaries(): string[] {
  return [
    'Respect the intent of the request: technical details within it may be settled, but never',
    'silently broaden its scope, override an explicit requirement, or invent a product preference',
    'to settle conflicting requirements. An explicit, bounded assumption is acceptable only when',
    'it stays within the request and leaves no consequential decision unresolved.',
  ];
}

function noRepositoryChanges(): string[] {
  return [
    'Do not edit, create or delete any file in the repository, and do not commit: return your',
    'answer only in your response.',
  ];
}

function findingFormat(): string[] {
  return [
    'Respond with JSON matching:',
    '{ "findings": Array<{ "id": string, "concern": string, "failureScenario": string,',
    '  "evidence": string[], "recommendation": string,',
    '  "resolution": "correction" | "operatorDecision", "uncertainty": string }> }',
    '"concern" names the requirement or decision affected; "failureScenario" is a concrete case',
    'that goes wrong; "uncertainty" is empty when nothing is in doubt. Return an empty findings',
    'list when the design and plan hold up — that alone approves them.',
  ];
}

export function designReReviewPrompt(inputs: DesignInputs & DesignReReview): string {
  return [
    'You are the design re-review of an automated SDLC pipeline. An earlier review of the',
    "planner's design and plan for the request below raised the findings listed further down.",
    'The planner has revised the documents once and answered each finding: either it addressed',
    'the finding in the documents, or it disputed it with evidence. This is the last review',
    'before the plan is sliced and built; there is no further revision.',
    '',
    ...originalInputs(inputs),
    ...documentsSection('DESIGN AS FIRST REVIEWED', inputs.reviewedDocs),
    ...documentsSection('REVISED DESIGN UNDER REVIEW', inputs.docs),
    ...findingsSection(inputs.findings),
    ...dispositionsSection(inputs.dispositions),
    'Check each earlier finding against the revised documents. A finding the planner addressed',
    'is resolved only when the revised documents actually settle it. A disputed finding is',
    "resolved when the planner's evidence holds up when you check it in the request or the",
    'repository; then drop it. Do not insist on a recommendation just because you made it.',
    'Also check whether the revision introduced a new consequential problem.',
    'Report every finding that still stands, and every new one; keep the id of a finding that',
    'still stands, and give a new finding an id no earlier finding used.',
    '',
    ...reviewRules(),
    ...findingFormat(),
  ].join('\n');
}

function findingsSection(findings: readonly DesignFinding[]): string[] {
  return ['--- REVIEW FINDINGS ---', ...findings.flatMap(findingLines), ''];
}

function findingLines(finding: DesignFinding): string[] {
  return [
    `Finding ${finding.id} (${finding.resolution === 'operatorDecision' ? 'needs an operator decision' : 'technical correction'})`,
    `  Concern: ${finding.concern}`,
    `  Failure scenario: ${finding.failureScenario}`,
    ...finding.evidence.map((evidence) => `  Evidence: ${evidence}`),
    `  Recommendation: ${finding.recommendation}`,
    ...(finding.uncertainty ? [`  Uncertainty: ${finding.uncertainty}`] : []),
  ];
}

function dispositionsSection(dispositions: readonly FindingDisposition[]): string[] {
  return ["--- PLANNER'S DISPOSITIONS ---", ...dispositions.flatMap(dispositionLines), ''];
}

function dispositionLines(disposition: FindingDisposition): string[] {
  if (disposition.status === 'addressed') {
    return [`Finding ${disposition.findingId}: addressed`, `  Change: ${disposition.change}`];
  }
  return [
    `Finding ${disposition.findingId}: disputed`,
    `  Reasoning: ${disposition.reasoning}`,
    ...disposition.evidence.map((evidence) => `  Evidence: ${evidence}`),
  ];
}

export function designRevisionPrompt(inputs: DesignInputs & { findings: DesignFinding[] }): string {
  return [
    'You are the design revision step of an automated SDLC pipeline. You wrote the design and',
    'implementation plan below for the request below; an independent reviewer raised the',
    'findings listed further down. This is your one chance to revise before the plan is',
    'reviewed a last time and then sliced and built.',
    '',
    ...originalInputs(inputs),
    ...documentsSection('DESIGN AS REVIEWED', inputs.docs),
    ...findingsSection(inputs.findings),
    'Answer every finding, exactly once, by its id:',
    '- "addressed": you changed the documents to settle it. Say what you changed.',
    '- "disputed": the finding is wrong. Give your reasoning and evidence from the request or the',
    '  repository that a reviewer can check. Investigate before you dispute; a disagreement',
    '  without evidence is not a dispute.',
    'A recommendation is not automatically right: follow it, settle the finding another way, or',
    'dispute it, whichever the evidence supports.',
    ...intentBoundaries(),
    '',
    'Return the complete revised documents, not the changes: the whole "design", and the whole',
    '"plan" with every step still under a `## Step N — <title>` heading, numbered from 1, each',
    'step small enough to map onto one slice.',
    ...noRepositoryChanges(),
    '',
    'Respond with JSON matching:',
    '{ "design": string, "plan": string, "dispositions": Array<',
    '  { "findingId": string, "status": "addressed", "change": string }',
    '  | { "findingId": string, "status": "disputed", "reasoning": string, "evidence": string[] }',
    '> }',
  ].join('\n');
}
