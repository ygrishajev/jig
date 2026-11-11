import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aContext,
  aDesignFinding,
  aFeaturePlan,
  designDocs,
} from '../../tests/support/builders.js';
import type { DesignFinding } from '../domain/design-review.js';
import {
  type DesignInputs,
  designReReviewPrompt,
  designReviewPrompt,
  designRevisionPrompt,
} from './design-review.js';

describe('design review prompts', () => {
  describe('designReviewPrompt', () => {
    it('gives the reviewer the original request, repository context, feature plan and both documents', () => {
      const { inputs } = setup();

      const prompt = designReviewPrompt(inputs);

      expectOriginalInputs(prompt, inputs);
      expect(prompt).toContain(inputs.docs.design);
      expect(prompt).toContain(inputs.docs.plan);
    });
  });

  describe('designRevisionPrompt', () => {
    it('gives the planner the original inputs, the reviewed documents and every finding in full', () => {
      const { inputs, findings } = setup();

      const prompt = designRevisionPrompt({ ...inputs, findings });

      expectOriginalInputs(prompt, inputs);
      expect(prompt).toContain(inputs.docs.plan);
      for (const finding of findings) expectFinding(prompt, finding);
    });

    it('leaves out the uncertainty line of a finding that has none', () => {
      const { inputs } = setup();
      const certain = aDesignFinding({ uncertainty: '' });
      const unsure = aDesignFinding({ uncertainty: faker.lorem.sentence() });

      const prompt = designRevisionPrompt({ ...inputs, findings: [certain, unsure] });

      expect(prompt.match(/Uncertainty:/g)).toHaveLength(1);
      expect(prompt).toContain(unsure.uncertainty);
    });
  });

  describe('designReReviewPrompt', () => {
    it('gives the reviewer both document versions, the earlier findings and the planner dispositions', () => {
      const { inputs, findings } = setup();
      const reviewedDocs = designDocs();
      const addressed = {
        findingId: findings[0].id,
        status: 'addressed' as const,
        change: faker.lorem.sentence(),
      };
      const disputed = {
        findingId: findings[1].id,
        status: 'disputed' as const,
        reasoning: faker.lorem.sentence(),
        evidence: [faker.lorem.sentence(), faker.lorem.sentence()],
      };

      const prompt = designReReviewPrompt({
        ...inputs,
        reviewedDocs,
        findings,
        dispositions: [addressed, disputed],
      });

      expectOriginalInputs(prompt, inputs);
      expect(prompt).toContain(reviewedDocs.plan);
      expect(prompt).toContain(inputs.docs.plan);
      expect(prompt.indexOf(reviewedDocs.plan)).toBeLessThan(prompt.indexOf(inputs.docs.plan));
      for (const finding of findings) expectFinding(prompt, finding);
      expect(prompt).toContain(addressed.change);
      expect(prompt).toContain(disputed.reasoning);
      for (const evidence of disputed.evidence) expect(prompt).toContain(evidence);
    });
  });

  function expectOriginalInputs(prompt: string, inputs: DesignInputs) {
    expect(prompt).toContain(inputs.request);
    expect(prompt).toContain(inputs.repoSummary);
    expect(prompt).toContain(inputs.plan.summary);
    expect(prompt).toContain(inputs.plan.approach);
    for (const area of inputs.plan.affectedAreas) expect(prompt).toContain(area);
  }

  function expectFinding(prompt: string, finding: DesignFinding) {
    expect(prompt).toContain(finding.id);
    expect(prompt).toContain(finding.concern);
    expect(prompt).toContain(finding.failureScenario);
    expect(prompt).toContain(finding.recommendation);
    for (const evidence of finding.evidence) expect(prompt).toContain(evidence);
  }

  function setup() {
    const inputs: DesignInputs = {
      request: faker.lorem.paragraphs(),
      repoSummary: aContext().repoSummary,
      plan: aFeaturePlan(),
      docs: designDocs(),
    };
    return { inputs, findings: [aDesignFinding(), aDesignFinding()] };
  }
});
