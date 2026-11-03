import { faker } from '@faker-js/faker';
import type { Result } from 'better-result';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { unwrap } from '../../../tests/support/unwrap.js';
import { AgentOutputInvalid } from '../../domain/errors.js';
import { extractOutput, OUTPUT_TAG } from './structured-output.js';

const verdictSchema = z.object({ approved: z.boolean(), feedback: z.string() });

describe('extractOutput', () => {
  it('reads the JSON inside the result tag, wherever it sits in the reply', () => {
    const verdict = { approved: faker.datatype.boolean(), feedback: faker.lorem.sentence() };
    const reply = `${faker.lorem.paragraph()}\n${tagged(JSON.stringify(verdict))}\n${faker.lorem.sentence()}`;

    expect(unwrap(extractOutput(reply, verdictSchema))).toEqual(verdict);
  });

  it('takes the last result when the agent corrected itself', () => {
    const draft = { approved: false, feedback: faker.lorem.sentence() };
    const final = { approved: true, feedback: faker.lorem.sentence() };
    const reply = [
      tagged(JSON.stringify(draft)),
      faker.lorem.sentence(),
      tagged(JSON.stringify(final)),
    ].join('\n');

    expect(unwrap(extractOutput(reply, verdictSchema))).toEqual(final);
  });

  it('accepts JSON wrapped in a code fence inside the tag', () => {
    const verdict = { approved: true, feedback: faker.lorem.sentence() };

    expect(
      unwrap(
        extractOutput(tagged(`\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``), verdictSchema),
      ),
    ).toEqual(verdict);
  });

  it('accepts a fenced result with blank lines around it inside the tag', () => {
    const verdict = { approved: true, feedback: faker.lorem.sentence() };

    expect(
      unwrap(
        extractOutput(
          tagged(`\n  \`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\n`),
          verdictSchema,
        ),
      ),
    ).toEqual(verdict);
  });

  it('rejects a fenced result with other text beside the fence', () => {
    const fenced = `\`\`\`json\n${JSON.stringify({ approved: true, feedback: '' })}\n\`\`\``;

    expectInvalid(extractOutput(tagged(`${faker.lorem.word()} ${fenced}`), verdictSchema));
    expectInvalid(extractOutput(tagged(`${fenced} ${faker.lorem.word()}`), verdictSchema));
  });

  it('rejects a reply without a result, with a result that is not JSON, or with the wrong shape', () => {
    expectInvalid(extractOutput(faker.lorem.paragraph(), verdictSchema));
    expectInvalid(extractOutput(tagged(faker.lorem.sentence()), verdictSchema));
    expectInvalid(
      extractOutput(tagged(JSON.stringify({ approved: faker.lorem.word() })), verdictSchema),
    );
  });
});

function expectInvalid(result: Result<unknown, unknown>) {
  expect(result.isErr() && result.error).toBeInstanceOf(AgentOutputInvalid);
}

function tagged(content: string) {
  return `<${OUTPUT_TAG}>${content}</${OUTPUT_TAG}>`;
}
