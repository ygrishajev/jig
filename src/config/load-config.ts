import { Result } from 'better-result';
import { z } from 'zod';

import { type AgentRole, agentRoleSchema, byRole } from '../domain/agent-role.js';
import type { RunSettings } from '../domain/settings.js';
import { AGENT_NAMES, agentNameSchema, resolvedModel } from './agent-policy.js';
import {
  type ConfigContents,
  ConfigNotJson,
  type ConfigSource,
  type ConfigUnreadable,
} from './config-source.js';
import { describeIssues } from './describe-issues.js';
import { ConfigInvalid } from './errors.js';

/** The settings at the source over every default; only the repository's own may be absent. */
export function loadConfig(source: ConfigSource): Result<JigConfig, ConfigInvalid> {
  return source
    .read()
    .mapError((failure) => unreadableConfig(source, failure))
    .andThen((contents) => settingsIn(source, contents))
    .andThen((json) => configFrom(source, json));
}

function unreadableConfig(
  source: ConfigSource,
  failure: ConfigUnreadable | ConfigNotJson,
): ConfigInvalid {
  return new ConfigInvalid({
    message:
      failure instanceof ConfigNotJson
        ? `${source.name} is not valid JSON: ${failure.detail}`
        : `Cannot read ${source.name}: ${failure.detail}`,
  });
}

function settingsIn(
  source: ConfigSource,
  contents: ConfigContents,
): Result<unknown, ConfigInvalid> {
  if (contents.kind === 'present') return Result.ok(contents.json);
  return source.custom
    ? Result.err(new ConfigInvalid({ message: `Cannot read ${source.name}: ${contents.detail}` }))
    : Result.ok({});
}

function configFrom(source: ConfigSource, json: unknown): Result<JigConfig, ConfigInvalid> {
  const parsed = configSchema.safeParse(json);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new ConfigInvalid({
          message: `${source.name} is not valid — ${describeIssues(parsed.error)}`,
        }),
      );
}

export const stepConfigSchema = z.object({
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
    ...byRole(() => stepConfigSchema.optional()),
  })
  .strict();

export type JigConfig = z.infer<typeof configSchema>;

/** The agent of every step; a run cannot start, nor its image be built, until each has one. */
export function configuredSteps(
  config: JigConfig,
): Result<Record<AgentRole, StepConfig>, ConfigInvalid> {
  const parsed = requiredStepsSchema.safeParse(config);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new ConfigInvalid({
      message: `No agent set for ${stepsWithoutAgent(config).join(', ')} — set each in the config to { "provider": "${AGENT_NAMES.join(' | ')}", "model": "..." }.`,
    }),
  );
}

const requiredStepsSchema = z.object(byRole(() => stepConfigSchema));

export function stepsWithoutAgent(config: JigConfig): AgentRole[] {
  return agentRoleSchema.options.filter((role) => !config[role]);
}

/** Risks a config can run with; jig names them on every start or resume and carries on. */
export function validationWarnings(config: JigConfig): string[] {
  return [reviewerSharesImplementerModel(config), approvalWithoutVerify(config)].filter(
    (warning) => warning !== undefined,
  );
}

function reviewerSharesImplementerModel({ implementer, reviewer }: JigConfig): string | undefined {
  if (!implementer || !reviewer || implementer.provider !== reviewer.provider) return undefined;
  const model = resolvedModel(implementer);
  if (model === undefined || model !== resolvedModel(reviewer)) return undefined;
  return `The implementer and reviewer are the same model (${implementer.provider}/${model}); a different reviewer catches more.`;
}

function approvalWithoutVerify({ verifyCommand }: JigConfig): string | undefined {
  if (verifyCommand !== undefined) return undefined;
  return "No verifyCommand is set: slices are approved on the reviewer's word alone. Run `jig init` to have one proposed, or set it in jig.config.json.";
}

/** The parts of the config that decide how a run moves, with the retry defaults jig fixes. */
export function runSettingsFrom(config: JigConfig): RunSettings {
  return {
    reviewCycleCap: config.reviewCycleCap,
    maxStepRetries: STEP_RETRIES,
    retryDelayMs: STEP_RETRY_DELAY_MS,
    designGate: config.designGate,
    mergeMode: config.mergeMode,
    verifyCommand: config.verifyCommand,
  };
}

/** How many times a step that failed transiently is tried again before the run blocks. */
const STEP_RETRIES = 2;

/** Long enough for a rate limit or a container hiccup to clear. */
const STEP_RETRY_DELAY_MS = 5000;
