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

    expect(prompt.indexOf(request)).toBeGreaterThan(prompt.indexOf('review all of them together'));
    expect(prompt).toContain('--- REQUEST START ---');
    expect(prompt).toContain(plan);
    expect(prompt).toContain(range);
  });

  it('tells the reviewer the verify command that passed in the sandbox for the run', () => {
    const command = `npm run ${faker.word.verb()}`;

    const prompt = finalCheckPrompt(setup({ verification: { command, passed: true } }));

    expect(prompt).toContain(`The verify command \`${command}\` passed in the sandbox`);
  });

  it("shows the reviewer the tail of a failed verification's output, not its head", () => {
    const command = `npm run ${faker.word.verb()}`;
    const head = faker.string.alpha(2000);
    const tail = faker.string.alpha(2000);

    const prompt = finalCheckPrompt(
      setup({ verification: { command, passed: false, output: `${head}${tail}` } }),
    );

    expect(prompt).toContain(`The verify command \`${command}\` failed in the sandbox`);
    expect(prompt).toContain(`…${`${head}${tail}`.slice(-FINAL_CHECK_OUTPUT_TAIL)}`);
    expect(prompt).not.toContain(head.slice(0, 500));
  });

  it('tells the reviewer to run the checks itself when no verify command is configured', () => {
    const prompt = finalCheckPrompt(setup({}));

    expect(prompt).toContain('No verify command is configured');
    expect(prompt).not.toContain('verify command `');
  });

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
