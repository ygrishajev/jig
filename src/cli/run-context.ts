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

export function selectProvider(config: SdlcConfig): AgentProvider {
  const profile = PROVIDER_PROFILES[config.providerCommand];
  if (!profile) {
    throw new Error(
      `Unknown providerCommand "${config.providerCommand}" — supported: ` +
        Object.keys(PROVIDER_PROFILES).join(', '),
    );
  }
  // Fails fast, before any container starts, if this provider's credentials
  // aren't available on the host — see each profile's own check for why.
  profile.assertCredentialsAvailable();
  return new DockerCliProvider({
    image: AGENT_SANDBOX_IMAGE,
    command: profile.command,
    buildArgs: profile.buildArgs,
    envVarsFromHost: profile.envVarsFromHost,
    hostFileMounts: profile.hostFileMounts,
  });
}

export { getCurrentBranch };
