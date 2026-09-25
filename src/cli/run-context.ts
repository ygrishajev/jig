import { loadConfig, type SdlcConfig } from '../config/load-config.js';
import { getCurrentBranch } from '../git/branch.js';
import { AutoMergeStrategy } from '../strategies/merge/auto.js';
import { ManualMergeStrategy } from '../strategies/merge/manual.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import { AgenticCliProvider } from '../strategies/provider/agentic-cli.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import { loadRunState, readRunMeta } from '../state/store.js';
import type { RunPaths } from '../state/run-paths.js';

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
  return new AgenticCliProvider({
    command: config.providerCommand,
    args: ['-p', '--output-format', 'text'],
  });
}

export { getCurrentBranch };
