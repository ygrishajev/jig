import { type AgentProvider, claudeCode, codex, opencode } from '@ai-hero/sandcastle';
import { Result } from 'better-result';

import { ConfigInvalid } from '../../domain/errors.js';
import { CREDENTIALS_FILE } from '../local-store/credentials-file.js';
import { codexLoginProblem } from './codex-auth.js';

export interface AgentDefinition {
  /** The npm package that installs the agent's CLI into the sandbox image. */
  npmPackage: string;
  /** Models offered when choosing this agent; any other name the agent accepts works too. */
  modelOptions: string[];
  /** Env vars that can authenticate it; any one of them is enough. */
  credentialKeys(model?: string): Result<string[], ConfigInvalid>;
  /** Where the operator gets the credential. */
  credentialHelp: string;
  /** Whether typing it should stay off the screen. */
  credentialIsSecret: boolean;
  /** Why a credential's value cannot work, when that can be told without running the agent. */
  credentialProblem(value: string): string | undefined;
  create(model?: string): Result<AgentProvider, ConfigInvalid>;
}

/** Which agent serves a role, and with which model. */
export interface AgentChoice {
  provider: AgentName;
  model?: string;
}

/** An agent that has none of the credentials that could authenticate it. */
export interface MissingCredential {
  provider: AgentName;
  keys: string[];
}

export function isAgentName(name: string): name is AgentName {
  return Object.hasOwn(AGENTS, name);
}

/** Used when a step names claude without a model; the CLI accepts the alias. */
export const DEFAULT_CLAUDE_MODEL = 'opus';

/** Every agent jig can run; adding one here is all the config and the sandbox image need. */
export const AGENTS = {
  claude: {
    npmPackage: '@anthropic-ai/claude-code',
    modelOptions: ['fable', 'opus', 'sonnet', 'haiku'],
    credentialKeys: () => Result.ok(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']),
    credentialHelp: '`claude setup-token` prints an OAuth token',
    credentialIsSecret: true,
    credentialProblem: () => undefined,
    create: (model) =>
      Result.ok(claudeCode(model ?? DEFAULT_CLAUDE_MODEL, { captureSessions: false })),
  },
  opencode: {
    npmPackage: 'opencode-ai',
    modelOptions: [],
    credentialKeys: (model) =>
      requireModel(model).map((required) => [`${modelProvider(required).toUpperCase()}_API_KEY`]),
    credentialHelp: "the API key of the model's provider",
    credentialIsSecret: true,
    credentialProblem: () => undefined,
    create: (model) => requireModel(model).map((required) => opencode(required)),
  },
  codex: {
    npmPackage: '@openai/codex',
    modelOptions: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna'],
    credentialKeys: () => Result.ok(['JIG_CODEX_AUTH_DIR']),
    credentialHelp: 'the folder holding your ChatGPT login, usually ~/.codex',
    credentialIsSecret: false,
    credentialProblem: codexLoginProblem,
    create: (model?: string) =>
      model
        ? Result.ok(codex(model, { captureSessions: false }))
        : Result.err(
            new ConfigInvalid({
              message: 'codex needs an explicit model — set "model" on the step.',
            }),
          ),
  },
} satisfies Record<string, AgentDefinition>;

export type AgentName = keyof typeof AGENTS;

function requireModel(model: string | undefined): Result<string, ConfigInvalid> {
  return model
    ? Result.ok(model)
    : Result.err(
        new ConfigInvalid({
          message:
            'opencode needs a model as "provider/model" (e.g. "openrouter/<model>") — set "model" on the step.',
        }),
      );
}

function modelProvider(model: string): string {
  return model.split('/')[0] ?? model;
}

/** What is wrong with running `provider` on `model`, if anything. */
export function modelProblem(provider: AgentName, model?: string): string | undefined {
  const created = AGENTS[provider].create(model);
  return created.isErr() ? created.error.message : undefined;
}

/**
 * The credentials every configured step needs, looked up by name. Fails before any container
 * starts, naming what to set, when a step's agent has no credential at all or one that cannot work.
 */
export function collectCredentials(
  steps: AgentChoice[],
  credential: (name: string) => string | undefined,
): Result<Record<string, string>, ConfigInvalid> {
  return missingCredentials(steps, credential).andThen((missing) => {
    if (missing.length > 0) {
      const wanted = missing
        .map(({ provider, keys }) => `${provider}: ${keys.join(' or ')}`)
        .join('; ');
      return Result.err(
        new ConfigInvalid({
          message: `Agent credentials are missing — set ${wanted} in the environment or in ${CREDENTIALS_FILE}.`,
        }),
      );
    }
    const collected = new Map(
      steps.flatMap((step) =>
        credentialKeysOf(step).flatMap((key) => {
          const value = credential(key);
          return value ? [[key, { value, provider: step.provider }] as const] : [];
        }),
      ),
    );
    for (const [key, { value, provider }] of collected) {
      const problem = AGENTS[provider].credentialProblem(value);
      if (problem) return Result.err(new ConfigInvalid({ message: `${key}: ${problem}` }));
    }
    return Result.ok(Object.fromEntries([...collected].map(([key, { value }]) => [key, value])));
  });
}

export function missingCredentials(
  steps: AgentChoice[],
  credential: (name: string) => string | undefined,
): Result<MissingCredential[], ConfigInvalid> {
  return Result.gen(function* () {
    const missing = new Map<string, MissingCredential>();
    for (const { provider, model } of steps) {
      const keys = yield* AGENTS[provider].credentialKeys(model);
      if (!keys.some((key) => credential(key))) missing.set(keys.join(), { provider, keys });
    }
    return Result.ok([...missing.values()]);
  });
}

function credentialKeysOf({ provider, model }: AgentChoice): string[] {
  const keys = AGENTS[provider].credentialKeys(model);
  return keys.isOk() ? keys.value : [];
}
