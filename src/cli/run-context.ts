import { loadConfig, type SdlcConfig } from '../config/load-config.js';
import { getCurrentBranch } from '../git/branch.js';
import { AutoMergeStrategy } from '../strategies/merge/auto.js';
import { ManualMergeStrategy } from '../strategies/merge/manual.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import { DockerCliProvider } from '../strategies/provider/docker-cli.js';
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
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'No agent credentials found. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`' +
        ' on your host once) or ANTHROPIC_API_KEY in your environment before running sdlc.',
    );
  }
  return new DockerCliProvider({
    image: AGENT_SANDBOX_IMAGE,
    command: config.providerCommand,
    // --dangerously-skip-permissions bypasses claude's interactive tool-use
    // approval gate. Without it, every file write / bash call in headless
    // (-p) mode silently fails (claude prints a permission request and exits
    // 0 with no side effect, no error) — unattended autopilot cannot work at
    // all otherwise, since there's no TTY to approve prompts against. This
    // flag is ONLY ever used here, wrapped in DockerCliProvider — never on
    // the bare host — so unattended full tool access is confined to the
    // sandbox container, not the machine sdlc itself runs on.
    args: ['-p', '--output-format', 'text', '--dangerously-skip-permissions'],
    envVarsFromHost: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  });
}

export { getCurrentBranch };
