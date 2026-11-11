import { Result } from 'better-result';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { AGENTS, DEFAULT_CLAUDE_MODEL, isAgentName } from '../adapters/sandcastle/agents.js';
import { type AgentRole, agentRoleSchema, byRole } from '../domain/agent-role.js';
import { ConfigInvalid, messageOf } from '../domain/errors.js';
import { MAX_STEP_RETRIES, RETRY_DELAY_MS, type RunSettings } from '../domain/settings.js';
import { describeIssues } from './describe-issues.js';

/** The config a command reads and writes: the repository's own, or a preset named with `--config`. */
export interface ConfigFile {
  path: string;
  name: string;
  /** A preset the operator named must exist; the repository's own may be absent. */
  named: boolean;
}

/** A named preset resolves against the repository root, where every command starts. */
export function configFileFor(repoRoot: string, preset?: string): ConfigFile {
  return preset === undefined
    ? { path: path.join(repoRoot, CONFIG_FILE), name: CONFIG_FILE, named: false }
    : { path: path.resolve(repoRoot, preset), name: preset, named: true };
}

export const CONFIG_FILE = 'jig.config.json';

export function loadConfig(file: ConfigFile): Result<JigConfig, ConfigInvalid> {
  return readConfigFile(file).andThen((contents) => parseConfig(file, contents));
}

function readConfigFile(file: ConfigFile): Result<string, ConfigInvalid> {
  if (!file.named && !existsSync(file.path)) return Result.ok('{}');
  return Result.try({
    try: () => readFileSync(file.path, 'utf-8'),
    catch: (cause) =>
      new ConfigInvalid({ message: `Cannot read ${file.name}: ${messageOf(cause)}` }),
  });
}

function parseConfig(file: ConfigFile, contents: string): Result<JigConfig, ConfigInvalid> {
  return Result.try({
    try: (): unknown => JSON.parse(contents),
    catch: (cause) =>
      new ConfigInvalid({
        message: `${file.name} is not valid JSON: ${messageOf(cause)}`,
      }),
  }).andThen((json) => {
    const parsed = configSchema.safeParse(json);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(
          new ConfigInvalid({
            message: `${file.name} is not valid — ${describeIssues(parsed.error)}`,
          }),
        );
  });
}

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
      message: `No agent set for ${stepsWithoutAgent(config).join(', ')} — set each in the config to { "provider": "${Object.keys(AGENTS).join(' | ')}", "model": "..." }.`,
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

/** Only claude has a model of its own to fall back to; the others run without one only to fail. */
function resolvedModel(step: StepConfig): string | undefined {
  return step.model ?? (step.provider === 'claude' ? DEFAULT_CLAUDE_MODEL : undefined);
}

function approvalWithoutVerify({ verifyCommand }: JigConfig): string | undefined {
  if (verifyCommand !== undefined) return undefined;
  return "No verifyCommand is set: slices are approved on the reviewer's word alone. Run `jig init` to have one proposed, or set it in jig.config.json.";
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
