import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { FINAL_CHECK_OUTPUT_TAIL } from '../domain/final-check.js';
import { finalCheckPrompt } from './final-check.js';

describe('finalCheckPrompt', () => {
  it('presents the original request, the plan and the range for the reviewer to judge the run by', () => {
    const request = `# ${faker.lorem.sentence()}\n\n${faker.lorem.paragraph()}`;
    const plan = `# Plan\n\n${faker.lorem.paragraph()}`;
    const range = `${faker.git.commitSha()}..HEAD`;

    const prompt = finalCheckPrompt({ request, plan, range });

    expect(prompt).toContain(request);
    expect(prompt).toContain(plan);
    expect(prompt).toContain(range);
  });

  it('gives the reviewer the verify command that passed in the sandbox for the run', () => {
    const command = `npm run ${faker.word.verb()}`;

    const prompt = finalCheckPrompt(setup({ verification: { command, passed: true } }));

    expect(prompt).toContain(command);
  });

  it("shows the reviewer the tail of a failed verification's output, not its head", () => {
    const command = `npm run ${faker.word.verb()}`;
    const head = faker.string.alpha(2000);
    const tail = faker.string.alpha(2000);

    const prompt = finalCheckPrompt(
      setup({ verification: { command, passed: false, output: `${head}${tail}` } }),
    );

    expect(prompt).toContain(`…${`${head}${tail}`.slice(-FINAL_CHECK_OUTPUT_TAIL)}`);
    expect(prompt).not.toContain(head.slice(0, 500));
  });

  it.each([true, false])(
    'replaces absent verification guidance for a recorded result: %s',
    (passed) => {
      const command = `npm run ${faker.lorem.slug()}`;
      const output = faker.lorem.paragraph();
      const input = setup({});
      const absent = finalCheckPrompt(input);
      const recorded = finalCheckPrompt({ ...input, verification: { command, passed, output } });
      const absentGuidance = absent.split('\n').filter((line) => !recorded.includes(line));

      expect(absentGuidance.length).toBeGreaterThan(0);
      expect(absent).not.toContain(command);
      expect(recorded).toContain(command);
      expect(recorded.includes(output)).toBe(!passed);
      for (const line of absentGuidance) expect(recorded).not.toContain(line);
    },
  );

  function setup(input: {
    request?: string;
    plan?: string;
    range?: string;
    verification?: { command?: string; passed: boolean; output?: string };
  }) {
    return {
      request: input.request ?? faker.lorem.paragraph(),
      plan: input.plan ?? faker.lorem.paragraph(),
      range: input.range ?? `${faker.git.commitSha()}..HEAD`,
      verification: input.verification,
    };
  }
});
