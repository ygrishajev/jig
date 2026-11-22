import { z } from 'zod';

export interface AgentChoice {
  provider: AgentName;
  model?: string;
}

export const AGENT_NAMES = ['claude', 'opencode', 'codex'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const agentNameSchema = z
  .string()
  .refine(isAgentName, { message: `the agent must be one of ${AGENT_NAMES.join(', ')}` });

function isAgentName(name: string): name is AgentName {
  return AGENT_NAMES.some((provider) => provider === name);
}

export function resolvedModel({ provider, model }: AgentChoice): string | undefined {
  return model ?? (provider === 'claude' ? DEFAULT_CLAUDE_MODEL : undefined);
}

/** The Claude CLI accepts this alias when a step does not select a model. */
export const DEFAULT_CLAUDE_MODEL = 'opus';
