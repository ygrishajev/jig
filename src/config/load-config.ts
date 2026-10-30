import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AGENTS, isAgentName } from '../adapters/sandcastle/agents.js';
import { byRole, type AgentRole } from '../domain/agent-role.js';

export const CONFIG_FILE = 'sdlc.config.json';

const agentNameSchema = z
  .string()
  .refine(isAgentName, { message: `the agent must be one of ${Object.keys(AGENTS).join(', ')}` });

const stepConfigSchema = z.object({
  provider: agentNameSchema,
  /** Passed to the agent CLI; claude falls back to a default, opencode requires one ("provider/model"). */
  model: z.string().optional(),
});
export type StepConfig = z.infer<typeof stepConfigSchema>;

/** Strict, so a misspelled key fails at load instead of silently falling back to a default. */
const configSchema = z
  .object({
    mergeMode: z.enum(['manual', 'auto']).default('manual'),
    reviewCycleCap: z.number().int().positive().default(3),
    /** Runs once per run, before any agent starts, e.g. `npm ci`. */
    setupCommand: z.string().optional(),
    setupTimeoutSeconds: z.number().int().positive().default(900),
    /** Must pass inside the sandbox before a reviewed slice counts as approved. */
    verifyCommand: z.string().optional(),
    /** `skip` disables signing in the run's worktree, for repos that sign through an agent the sandbox cannot reach. */
    commitSigning: z.enum(['repo', 'skip']).default('repo'),
    /** `checkpoint` stops after planning so a person can read the design and plan before any code is written. */
    designGate: z.enum(['auto', 'checkpoint']).default('auto'),
    /** An image managed elsewhere: sdlc starts it as it is and never builds it. */
    sandboxImage: z.string().optional(),
    /** Where run state is saved: `local`, `git-remote` (push to origin), or a path to a store module. */
    runStores: z.array(z.string()).min(1).default(['local']),
    /** Exact agent CLI versions to install; an agent without a pin follows `agentUpdates`. */
    agents: z.record(agentNameSchema, z.string()).default({}),
    /** `auto` rebuilds the agent layer when a newer release is out, `warn` only says so, `off` never checks. */
    agentUpdates: z.enum(['auto', 'warn', 'off']).default('auto'),
    /** Silence this long means the agent hung; it is stopped. */
    agentIdleTimeoutSeconds: z.number().int().positive().default(600),
    ...byRole(() => stepConfigSchema.default({ provider: 'claude' })),
  })
  .strict();
export type SdlcConfig = z.infer<typeof configSchema>;

export function loadConfig(repoRoot: string): SdlcConfig {
  const configPath = path.join(repoRoot, CONFIG_FILE);
  if (!existsSync(configPath)) return configSchema.parse({});
  return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
}

export function configuredSteps(config: SdlcConfig): Record<AgentRole, StepConfig> {
  return byRole((role) => config[role]);
}
