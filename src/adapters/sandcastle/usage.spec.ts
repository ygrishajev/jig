import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { usageFromStreamLine } from './usage.js';

describe('usageFromStreamLine', () => {
  it("reads cost and tokens from claude's closing result event", () => {
    const usage = {
      input_tokens: count(),
      output_tokens: count(),
      cache_read_input_tokens: count(),
      cache_creation_input_tokens: count(),
      output_tokens_details: { thinking_tokens: count() },
    };
    const costUsd = faker.number.float({ min: 0.0001, max: 2, fractionDigits: 6 });

    const result = usageFromStreamLine(
      JSON.stringify({ type: 'result', total_cost_usd: costUsd, usage }),
    );

    expect(result).toEqual({
      costUsd,
      tokens: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        reasoning: usage.output_tokens_details.thinking_tokens,
      },
    });
  });

  it("reads cost and tokens from opencode's step_finish event", () => {
    const tokens = {
      input: count(),
      output: count(),
      reasoning: count(),
      cache: { read: count(), write: count() },
    };
    const cost = faker.number.float({ min: 0.0001, max: 2, fractionDigits: 8 });

    const result = usageFromStreamLine(
      JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', cost, tokens } }),
    );

    expect(result).toEqual({
      costUsd: cost,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
        reasoning: tokens.reasoning,
      },
    });
  });

  it('ignores lines that report no usage', () => {
    expect(usageFromStreamLine(faker.lorem.sentence())).toBeUndefined();
    expect(
      usageFromStreamLine(JSON.stringify({ type: 'assistant', message: faker.lorem.sentence() })),
    ).toBeUndefined();
  });
});

function count() {
  return faker.number.int({ min: 0, max: 50_000 });
}
