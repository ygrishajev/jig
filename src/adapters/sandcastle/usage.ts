import { z } from 'zod';

import type { TokenUsage } from '../../domain/usage.js';

export interface AgentCallUsage {
  costUsd?: number;
  tokens: TokenUsage;
}

/** The usage an agent's raw stream line reports, if it reports any; agents price their own calls. */
export function usageFromStreamLine(line: string): AgentCallUsage | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }

  const claude = claudeResultSchema.safeParse(event);
  if (claude.success) {
    const usage = claude.data.usage;
    return {
      costUsd: claude.data.total_cost_usd,
      tokens: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
      },
    };
  }

  const opencode = opencodeStepSchema.safeParse(event);
  if (opencode.success) {
    const { cost, tokens } = opencode.data.part;
    return {
      costUsd: cost,
      tokens: {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
        reasoning: tokens.reasoning,
      },
    };
  }
  return undefined;
}

/** Claude Code ends every print-mode call with one `result` event carrying the call's totals. */
const claudeResultSchema = z.object({
  type: z.literal('result'),
  total_cost_usd: z.number().optional(),
  usage: z.object({
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    cache_read_input_tokens: z.number().default(0),
    cache_creation_input_tokens: z.number().default(0),
    output_tokens_details: z.object({ thinking_tokens: z.number().default(0) }).optional(),
  }),
});

/** opencode reports each model step's tokens and cost in a `step_finish` event. */
const opencodeStepSchema = z.object({
  type: z.literal('step_finish'),
  part: z.object({
    cost: z.number().optional(),
    tokens: z.object({
      input: z.number().default(0),
      output: z.number().default(0),
      reasoning: z.number().default(0),
      cache: z.object({ read: z.number().default(0), write: z.number().default(0) }).default({}),
    }),
  }),
});
