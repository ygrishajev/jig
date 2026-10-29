import { claudeCode, opencode, type AgentProvider } from '@ai-hero/sandcastle';
import type { StepConfig } from '../../config/load-config.js';
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

export const AGENTS: Record<StepConfig['provider'], AgentDefinition> = {
  claude: {
    npmPackage: '@anthropic-ai/claude-code',
    credentialKeys: () => ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    create: (model) => claudeCode(model ?? DEFAULT_CLAUDE_MODEL),
  },
  opencode: {
    npmPackage: 'opencode-ai',
    credentialKeys: (model) => [`${modelProvider(requireModel(model)).toUpperCase()}_API_KEY`],
    create: (model) => opencode(requireModel(model)),
  },
};

/**
 * The env vars every configured step needs, read from `environment`. Fails before any
 * container starts, naming what to set, when a step's agent has no credential at all.
 */
export function collectCredentials(steps: StepConfig[], environment: NodeJS.ProcessEnv) {
  const credentials: Record<string, string> = {};
  for (const step of steps) {
    const keys = AGENTS[step.provider].credentialKeys(step.model);
    const present = keys.filter((key) => environment[key]);
    if (present.length === 0) {
      throw new ConfigInvalid(
        `No ${step.provider} credentials found — set ${keys.join(' or ')} in the environment.`,
      );
    }
    for (const key of present) credentials[key] = environment[key] as string;
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
