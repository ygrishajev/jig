import type { SdlcConfig, StepConfig } from '../config/load-config.js';
import { ConfigInvalid } from '../domain/errors.js';
import type { AgentRole } from '../ports/agent-session.js';
import { DockerCliProvider } from '../adapters/docker-cli/docker-cli.js';
import { PROVIDER_PROFILES } from '../adapters/docker-cli/provider-profiles.js';
import type { AgentProvider } from '../adapters/docker-cli/types.js';

/** A registry-backed image (set in CI) is re-pulled every run; a locally built one never is. */
function sandboxImage() {
  const image = process.env.SDLC_AGENT_SANDBOX_IMAGE;
  return image
    ? { image, pullPolicy: 'always' as const }
    : { image: 'sdlc-agent-sandbox', pullPolicy: 'missing' as const };
}

/** One agent per role, each checked for credentials before any container starts. */
export function buildAgentProviders(config: SdlcConfig): Record<AgentRole, AgentProvider> {
  return {
    planner: buildProvider(config.planner),
    implementer: buildProvider(config.implementer),
    reviewer: buildProvider(config.reviewer),
    describer: buildProvider(config.describer),
  };
}

function buildProvider(step: StepConfig): AgentProvider {
  const profile = PROVIDER_PROFILES[step.provider];
  if (!profile) {
    throw new ConfigInvalid(
      `Unknown provider "${step.provider}" — supported: ${Object.keys(PROVIDER_PROFILES).join(', ')}`,
    );
  }
  try {
    profile.assertCredentialsAvailable();
  } catch (error) {
    throw new ConfigInvalid(error instanceof Error ? error.message : String(error));
  }
  return new DockerCliProvider({
    ...sandboxImage(),
    command: profile.command,
    buildArgs: (prompt) => profile.buildArgs(prompt, step.model),
    envVarsFromHost: profile.envVarsFromHost,
    hostEnvFileMounts: profile.hostEnvFileMounts,
  });
}
