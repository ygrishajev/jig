import { execa, ExecaError } from 'execa';
import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export interface DockerCliProviderOptions {
  image: string;
  command: string;
  args?: string[];
  /** Host environment variable names to pass into the container, unchanged. */
  envVarsFromHost?: string[];
  timeoutMs?: number;
  /** The `docker` binary to invoke. Overridable for tests; defaults to `docker`. */
  dockerCommand?: string;
}

/**
 * Runs an agentic CLI inside a throwaway Docker container instead of
 * directly on the host. `input.cwd` is bind-mounted to `/workspace` (both
 * for `prepare`'s repo-root calls and `implement`/`review`'s slice
 * worktree), so code changes land on the host's real files even though the
 * container itself is discarded after each call — the container is the
 * sandbox, not the source of truth for anything written to disk.
 */
export class DockerCliProvider implements AgentProvider {
  constructor(private readonly options: DockerCliProviderOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const {
      image,
      command,
      args = [],
      envVarsFromHost = [],
      timeoutMs,
      dockerCommand = 'docker',
    } = this.options;
    const dockerArgs = [
      'run',
      '--rm',
      '-v',
      `${input.cwd}:/workspace`,
      '-w',
      '/workspace',
      ...hostEnvArgs(envVarsFromHost),
      image,
      command,
      ...args,
      input.prompt,
    ];
    try {
      const result = await execa(dockerCommand, dockerArgs, { timeout: timeoutMs, reject: false });
      const success = result.exitCode === 0;
      const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
      const output = !success && !combinedOutput ? (result.shortMessage ?? '') : combinedOutput;
      return { success, output };
    } catch (error) {
      const output =
        error instanceof ExecaError
          ? error.shortMessage
          : error instanceof Error
            ? error.message
            : String(error);
      return { success: false, output };
    }
  }
}

function hostEnvArgs(envVarNames: string[]): string[] {
  return envVarNames.flatMap((name) => {
    const value = process.env[name];
    return value ? ['-e', `${name}=${value}`] : [];
  });
}
