import { loadConfig, type SdlcConfig } from '../config/load-config.js';
import { getCurrentBranch } from '../git/branch.js';
import { AutoMergeStrategy } from '../strategies/merge/auto.js';
import { ManualMergeStrategy } from '../strategies/merge/manual.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import { DockerCliProvider } from '../strategies/provider/docker-cli.js';
import { PROVIDER_PROFILES } from '../strategies/provider/provider-profiles.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import { loadRunState, readRunMeta } from '../state/store.js';
import type { RunPaths } from '../state/run-paths.js';

const AGENT_SANDBOX_IMAGE = 'sdlc-agent-sandbox';

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
 * Builds the provider for `providerCommand` by default. Pass an explicit
 * `providerCommandOverride` to build a provider for a *different* step —
 * e.g. `selectProvider(config, config.implementProviderCommand)` — falling
 * back to `providerCommand` when the override is unset.
 */
export function selectProvider(
  config: SdlcConfig,
  providerCommandOverride?: SdlcConfig['providerCommand'],
): AgentProvider {
  const providerCommand = providerCommandOverride ?? config.providerCommand;
  const profile = PROVIDER_PROFILES[providerCommand];
  if (!profile) {
    throw new Error(
      `Unknown providerCommand "${providerCommand}" — supported: ` +
        Object.keys(PROVIDER_PROFILES).join(', '),
    );
  }
  // Fails fast, before any container starts, if this provider's credentials
  // aren't available on the host — see each profile's own check for why.
  profile.assertCredentialsAvailable();
  return new DockerCliProvider({
    image: AGENT_SANDBOX_IMAGE,
    command: profile.command,
    buildArgs: (prompt) => profile.buildArgs(prompt, config.opencodeModel),
    envVarsFromHost: profile.envVarsFromHost,
    hostFileMounts: profile.hostFileMounts,
  });
}

/** The provider for the implement step specifically — see `implementProviderCommand`. */
export function selectImplementProvider(config: SdlcConfig): AgentProvider {
  return selectProvider(config, config.implementProviderCommand);
}

export { getCurrentBranch };
