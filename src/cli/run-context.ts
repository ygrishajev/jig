import {
  loadConfig,
  type SdlcConfig,
  type StepConfig,
  type StepName,
} from '../config/load-config.js';
import { getCurrentBranch } from '../git/branch.js';
import { AutoMergeStrategy } from '../strategies/merge/auto.js';
import { ManualMergeStrategy } from '../strategies/merge/manual.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import { DockerCliProvider } from '../strategies/provider/docker-cli.js';
import { PROVIDER_PROFILES } from '../strategies/provider/provider-profiles.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import { loadRunState, readRunMeta } from '../state/store.js';
import type { RunPaths } from '../state/run-paths.js';

// Overridable so CI can point at a pre-built image (e.g. from a registry)
// instead of needing a local `docker build` — see README's CI section.
const AGENT_SANDBOX_IMAGE = process.env.SDLC_AGENT_SANDBOX_IMAGE ?? 'sdlc-agent-sandbox';
// Only a registry-backed image (SDLC_AGENT_SANDBOX_IMAGE set) can be
// re-pulled — see DockerCliProviderOptions.pullPolicy for why this can't
// default to 'always' for the local `docker build` tag too.
const AGENT_SANDBOX_PULL_POLICY = process.env.SDLC_AGENT_SANDBOX_IMAGE ? 'always' : 'missing';

export interface CliRunContext {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  config: SdlcConfig;
  mergeStrategy: MergeStrategy;
}

export async function loadCliRunContext(repoRoot: string, runId: string): Promise<CliRunContext> {
  const paths = await loadRunState(repoRoot, runId);
  const meta = await readRunMeta(paths);
  const config = loadConfig(repoRoot);
  return {
    repoRoot,
    paths,
    baseBranch: meta.baseBranch,
    config,
    mergeStrategy:
      config.mergeMode === 'auto' ? new AutoMergeStrategy() : new ManualMergeStrategy(),
  };
}

/**
 * Builds the provider for one pipeline step. Each step (`planner`,
 * `implementer`, `reviewer`) carries its own provider and optional model from
 * config, so different steps can run on different agents/models.
 */
export function selectProvider(config: SdlcConfig, step: StepName): AgentProvider {
  return buildProvider(config[step]);
}

function buildProvider(stepConfig: StepConfig): AgentProvider {
  const profile = PROVIDER_PROFILES[stepConfig.provider];
  if (!profile) {
    throw new Error(
      `Unknown provider "${stepConfig.provider}" — supported: ` +
        Object.keys(PROVIDER_PROFILES).join(', '),
    );
  }
  // Fails fast, before any container starts, if this provider's credentials
  // aren't available on the host — see each profile's own check for why.
  profile.assertCredentialsAvailable();
  return new DockerCliProvider({
    image: AGENT_SANDBOX_IMAGE,
    command: profile.command,
    buildArgs: (prompt) => profile.buildArgs(prompt, stepConfig.model),
    envVarsFromHost: profile.envVarsFromHost,
    hostEnvFileMounts: profile.hostEnvFileMounts,
    pullPolicy: AGENT_SANDBOX_PULL_POLICY,
  });
}

export { getCurrentBranch };
