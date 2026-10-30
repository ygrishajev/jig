import { type AgentProvider, claudeCode, codex, opencode } from '@ai-hero/sandcastle';

import { ConfigInvalid } from '../../domain/errors.js';

/** Used when a step names claude without a model; the CLI accepts the alias. */
export const DEFAULT_CLAUDE_MODEL = 'opus';

export interface AgentDefinition {
  /** The npm package that installs the agent's CLI into the sandbox image. */
  npmPackage: string;
  /** Env vars that can authenticate it; any one of them is enough. */
  credentialKeys(model?: string): string[];
  create(model?: string): AgentProvider;
}

/** Every agent sdlc can run; adding one here is all the config and the sandbox image need. */
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
    credentialKeys: () => ['SDLC_CODEX_AUTH_DIR'],
    create: (model?: string) => {
      if (!model)
        throw new ConfigInvalid('codex needs an explicit model — set "model" on the step.');
      return codex(model, { captureSessions: false });
    },
  },
} satisfies Record<string, AgentDefinition>;

export type AgentName = keyof typeof AGENTS;

/** Which agent serves a role, and with which model. */
export interface AgentChoice {
  provider: AgentName;
  model?: string;
}

export function isAgentName(name: string): name is AgentName {
  return Object.hasOwn(AGENTS, name);
}

/**
 * The env vars every configured step needs, read from `environment`. Fails before any
 * container starts, naming what to set, when a step's agent has no credential at all.
 */
export function collectCredentials(steps: AgentChoice[], environment: NodeJS.ProcessEnv) {
  const credentials: Record<string, string> = {};
  for (const step of steps) {
    const keys = AGENTS[step.provider].credentialKeys(step.model);
    const present = keys.flatMap((key) => {
      const value = environment[key];
      return value ? [[key, value] as const] : [];
    });
    if (present.length === 0) {
      throw new ConfigInvalid(
        `No ${step.provider} credentials found — set ${keys.join(' or ')} in the environment.`,
      );
    }
    for (const [key, value] of present) credentials[key] = value;
  }
  return credentials;
}

function requireModel(model: string | undefined) {
  if (!model) {
    throw new ConfigInvalid(
      'opencode needs a model as "provider/model" (e.g. "openrouter/<model>") — set "model" on the step.',
    );
  }
  return model;
}

function modelProvider(model: string) {
  return model.split('/')[0] ?? model;
}
