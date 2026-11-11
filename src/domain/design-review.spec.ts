import { faker } from '@faker-js/faker';
import { Panic } from 'better-result';
import { describe, expect, it } from 'vitest';

import {
  aDesignFinding,
  aDesignReview,
  aDisposition,
  aFirstDesignReview,
  aRevisedDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
  designDocs,
} from '../../tests/support/builders.js';
import {
  designApproved,
  designNeedsRevision,
  designReReview,
  type DesignReviewProgress,
  designReviewProgressSchema,
  designReviewSchema,
  designReviewStage,
  designRevisionSchemaFor,
  recordDesignReview,
  recordDesignRevision,
  resolveDesignReview,
} from './design-review.js';
import { DesignUnresolved } from './errors.js';
import type { RunPhase } from './run-state.js';

describe('designReviewSchema', () => {
  it('accepts findings that each carry evidence and a distinct id', () => {
    const review = aDesignReview({ findings: [aDesignFinding(), aDesignFinding()] });

    expect(designReviewSchema.parse(review)).toEqual(review);
  });

  it('refuses findings that share an id', () => {
    const repeated = aDesignFinding();

    const parsed = designReviewSchema.safeParse({
      findings: [repeated, aDesignFinding({ id: repeated.id })],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.message).toContain(repeated.id);
  });

  it('refuses a finding without evidence or without a stated uncertainty', () => {
    const { uncertainty: _dropped, ...unstated } = aDesignFinding();

    expect(
      designReviewSchema.safeParse({ findings: [aDesignFinding({ evidence: [] })] }).success,
    ).toBe(false);
    expect(designReviewSchema.safeParse({ findings: [unstated] }).success).toBe(false);
  });

  it('refuses a verdict field in place of findings', () => {
    expect(designReviewSchema.safeParse({ approved: true }).success).toBe(false);
  });
});

describe('designRevisionSchemaFor', () => {
  it('accepts revised documents with exactly one disposition per finding', () => {
    const findings = [aDesignFinding(), aDesignFinding()];
    const revision = {
      ...designDocs(),
      dispositions: [aDisposition(findings[0], 'addressed'), aDisposition(findings[1], 'disputed')],
    };

    expect(designRevisionSchemaFor(findings).parse(revision)).toEqual(revision);
  });

  it('refuses a revision that leaves a finding unanswered, answers an unknown one, or answers one twice', () => {
    const [answered, unanswered] = [aDesignFinding(), aDesignFinding()];
    const unknown = aDesignFinding();
    const schema = designRevisionSchemaFor([answered, unanswered]);

    const parsed = schema.safeParse({
      ...designDocs(),
      dispositions: [aDisposition(answered), aDisposition(answered), aDisposition(unknown)],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining(unanswered.id),
      expect.stringContaining(unknown.id),
      expect.stringContaining(answered.id),
    ]);
  });

  it('refuses a dispute that brings no evidence', () => {
    const finding = aDesignFinding();
    const dispute = { ...aDisposition(finding, 'disputed'), evidence: [] };

    const parsed = designRevisionSchemaFor([finding]).safeParse({
      ...designDocs(),
      dispositions: [dispute],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('designReviewProgressSchema', () => {
  it('refuses a second review saved without the revision it reviewed', () => {
    const progress = aRevisedDesignReview();

    expect(designReviewProgressSchema.safeParse(progress).success).toBe(true);
    expect(designReviewProgressSchema.safeParse({ ...progress, revision: undefined }).success).toBe(
      false,
    );
  });

  it('refuses more reviews than the cap', () => {
    const progress = aRevisedDesignReview();

    const parsed = designReviewProgressSchema.safeParse({
      ...progress,
      reviews: [...progress.reviews, aDesignReview()],
    });

    expect(parsed.success).toBe(false);
  });
});

describe('recording the design review', () => {
  it('records the first review and asks for a revision only when it found something', () => {
    const findings = [aDesignFinding()];

    const approved = recordDesignReview(aRunState(), { findings: [] });
    const challenged = recordDesignReview(aRunState(), { findings });

    expect(designApproved(approved)).toBe(true);
    expect(designNeedsRevision(approved)).toBe(false);
    expect(challenged.designReview).toEqual({ reviews: [{ findings }] });
    expect(designApproved(challenged)).toBe(false);
    expect(designNeedsRevision(challenged)).toBe(true);
  });

  it('replaces the documents with the revision and keeps the reviewed ones for the re-review', () => {
    const findings = [aDesignFinding()];
    const reviewedDocs = designDocs();
    const revised = designDocs();
    const dispositions = findings.map((finding) => aDisposition(finding));
    const state = aRunState({
      docs: reviewedDocs,
      designReview: aFirstDesignReview({ findings }),
    });

    const recorded = recordDesignRevision(state, { ...revised, dispositions });

    expect(recorded.docs).toEqual(revised);
    expect(designNeedsRevision(recorded)).toBe(false);
    expect(designReReview(recorded)).toEqual({ reviewedDocs, findings, dispositions });
  });

  it('owes no re-review context before the revision', () => {
    expect(designReReview(aRunState({ designReview: aFirstDesignReview() }))).toBeUndefined();
  });

  it('owes no second revision once the re-review is in, whatever it found', () => {
    const state = aRunState({ designReview: aRevisedDesignReview() });

    expect(designNeedsRevision(state)).toBe(false);
    expect(() => recordDesignRevision(state, { ...designDocs(), dispositions: [] })).toThrow(Panic);
  });

  it('treats a review beyond the cap, or a re-review without a revision, as a bug', () => {
    const capped = aRunState({ designReview: aRevisedDesignReview() });
    const unrevised = aRunState({ designReview: aFirstDesignReview() });

    expect(() => recordDesignReview(capped, aDesignReview())).toThrow(Panic);
    expect(() => recordDesignReview(unrevised, aDesignReview())).toThrow(Panic);
  });

  it('refuses a revision for a design the review approved', () => {
    const approved = aRunState({ designReview: { reviews: [{ findings: [] }] } });

    expect(() => recordDesignRevision(approved, { ...designDocs(), dispositions: [] })).toThrow(
      Panic,
    );
  });
});

describe('resolveDesignReview', () => {
  it('lets a design through once its latest review found nothing', () => {
    const progress = aRevisedDesignReview({ outstanding: [] });

    expect(resolveDesignReview(progress).isOk()).toBe(true);
  });

  it('blocks on every finding still standing, naming which need the operator', () => {
    const decision = aDesignFinding({ resolution: 'operatorDecision' });
    const correction = aDesignFinding({ resolution: 'correction' });
    const progress = aRevisedDesignReview({ outstanding: [decision, correction] });

    const resolved = resolveDesignReview(progress);

    expect(resolved.isErr() && resolved.error).toBeInstanceOf(DesignUnresolved);
    expect(resolved.isErr() && resolved.error.kind).toBe('block');
    expect(resolved.isErr() && resolved.error.findingIds).toEqual([decision.id, correction.id]);
    const lines = resolved.isErr() ? resolved.error.message.split('\n') : [];
    const lineOf = (id: string) => lines.find((line) => line.includes(id)) ?? '';
    expect(lineOf(decision.id)).toContain(decision.concern);
    expect(lineOf(decision.id)).toContain('operator decision');
    expect(lineOf(correction.id)).toContain(correction.recommendation);
    expect(lineOf(correction.id)).not.toContain('operator decision');
  });

  it('counts a re-review finding the earlier review never raised as unresolved', () => {
    const introduced = aDesignFinding({ id: `${faker.lorem.slug()}-new` });
    const progress = aRevisedDesignReview({ outstanding: [introduced] });

    const resolved = resolveDesignReview(progress);

    expect(resolved.isErr() && resolved.error.findingIds).toEqual([introduced.id]);
  });
});

describe('designReviewStage', () => {
  it('reports a design awaiting its first review as pending, never approved', () => {
    expect(designReviewStage(aRunState({ phase: 'reviewingDesign' }))).toBe('awaitingReview');
  });

  it('follows the review through its revision and re-review', () => {
    const stageOf = (designReview: DesignReviewProgress, phase: RunPhase) =>
      designReviewStage(aRunState({ phase, designReview }));

    expect(stageOf(aFirstDesignReview(), 'revisingDesign')).toBe('awaitingRevision');
    expect(stageOf(aRevisionAwaitingReReview(), 'reviewingDesign')).toBe('awaitingReReview');
    expect(stageOf(aRevisedDesignReview(), 'resolvingDesign')).toBe('unresolved');
  });

  it('approves a design whose latest review found nothing, first time or after the revision', () => {
    const stageOf = (designReview: DesignReviewProgress) =>
      designReviewStage(aRunState({ phase: 'slicing', designReview }));

    expect(stageOf({ reviews: [{ findings: [] }] })).toBe('approved');
    expect(stageOf(aRevisedDesignReview({ outstanding: [] }))).toBe('approved');
  });

  it('has no stage for a run before its design, or one saved before design reviews existed', () => {
    expect(designReviewStage(aRunState({ phase: 'designing' }))).toBeUndefined();
    expect(designReviewStage(aRunState({ phase: 'slices' }))).toBeUndefined();
  });
});
