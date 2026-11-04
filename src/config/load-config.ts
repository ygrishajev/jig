import { Result } from 'better-result';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { AGENTS, isAgentName } from '../adapters/sandcastle/agents.js';
import { type AgentRole, byRole } from '../domain/agent-role.js';
import { ConfigInvalid } from '../domain/errors.js';
import { MAX_STEP_RETRIES, RETRY_DELAY_MS, type RunSettings } from '../domain/settings.js';
import { describeIssues } from './describe-issues.js';

export function loadConfig(repoRoot: string): Result<JigConfig, ConfigInvalid> {
  const configPath = path.join(repoRoot, CONFIG_FILE);
  const contents = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
  return Result.try({
    try: (): unknown => JSON.parse(contents),
    catch: (cause) =>
      new ConfigInvalid({
        message: `${CONFIG_FILE} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).andThen((json) => {
    const parsed = configSchema.safeParse(json);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(
          new ConfigInvalid({
            message: `${CONFIG_FILE} is not valid — ${describeIssues(parsed.error)}`,
          }),
        );
  });
}

export const CONFIG_FILE = 'jig.config.json';

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
    commitSigning: z.enum(['repo', 'skip']).default('skip'),
    /** `checkpoint` stops after planning so a person can read the design and plan before any code is written. */
    designGate: z.enum(['auto', 'checkpoint']).default('auto'),
    /** An image managed elsewhere: jig starts it as it is and never builds it. */
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

export type JigConfig = z.infer<typeof configSchema>;

export function configuredSteps(config: JigConfig): Record<AgentRole, StepConfig> {
  return byRole((role) => config[role]);
}

/** The parts of the config that decide how a run moves, with the retry policy jig fixes. */
export function runSettingsFrom(config: JigConfig): RunSettings {
  return {
    reviewCycleCap: config.reviewCycleCap,
    maxStepRetries: MAX_STEP_RETRIES,
    retryDelayMs: RETRY_DELAY_MS,
    designGate: config.designGate,
    mergeMode: config.mergeMode,
    verifyCommand: config.verifyCommand,
  };
}
