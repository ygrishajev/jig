import { type AgentProvider, claudeCode, codex, opencode } from '@ai-hero/sandcastle';

import { ConfigInvalid } from '../../domain/errors.js';

export interface AgentDefinition {
  /** The npm package that installs the agent's CLI into the sandbox image. */
  npmPackage: string;
  /** Env vars that can authenticate it; any one of them is enough. */
  credentialKeys(model?: string): string[];
  create(model?: string): AgentProvider;
}

/** Which agent serves a role, and with which model. */
export interface AgentChoice {
  provider: AgentName;
  model?: string;
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
    credentialKeys: () => ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    create: (model) => claudeCode(model ?? DEFAULT_CLAUDE_MODEL, { captureSessions: false }),
  },
  opencode: {
    npmPackage: 'opencode-ai',
    credentialKeys: (model) => [`${modelProvider(requireModel(model)).toUpperCase()}_API_KEY`],
    create: (model) => opencode(requireModel(model)),
  },
  codex: {
    npmPackage: '@openai/codex',
    credentialKeys: () => ['JIG_CODEX_AUTH_DIR'],
    create: (model?: string) => {
      if (!model)
        throw new ConfigInvalid({
          message: 'codex needs an explicit model — set "model" on the step.',
        });
      return codex(model, { captureSessions: false });
    },
  },
} satisfies Record<string, AgentDefinition>;

export type AgentName = keyof typeof AGENTS;

function modelProvider(model: string): string {
  return model.split('/')[0] ?? model;
}

function requireModel(model: string | undefined): string {
  if (!model) {
    throw new ConfigInvalid({
      message:
        'opencode needs a model as "provider/model" (e.g. "openrouter/<model>") — set "model" on the step.',
    });
  }
  return model;
}

/**
 * The credentials every configured step needs, looked up by name. Fails before any container
 * starts, naming what to set, when a step's agent has no credential at all.
 */
export function collectCredentials(
  steps: AgentChoice[],
  credential: (name: string) => string | undefined,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const step of steps) {
    const keys = AGENTS[step.provider].credentialKeys(step.model);
    const present = keys.flatMap((key) => {
      const value = credential(key);
      return value ? [[key, value] as const] : [];
    });
    if (present.length === 0) {
      throw new ConfigInvalid({
        message: `No ${step.provider} credentials found — set ${keys.join(' or ')} in the environment.`,
      });
    }
    for (const [key, value] of present) credentials[key] = value;
  }
  return credentials;
}
