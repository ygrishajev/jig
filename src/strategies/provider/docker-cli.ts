import { execa, ExecaError } from 'execa';
import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export interface HostFileMount {
  hostPath: string;
  containerPath: string;
}

export interface DockerCliProviderOptions {
  image: string;
  command: string;
  /**
   * Builds the full argument list for one invocation, given the prompt.
   * A function rather than a flat `args` array plus an implicit trailing
   * prompt, because different CLIs place the prompt in different positions
   * (e.g. `claude -p "<prompt>" --output-format text` vs.
   * `opencode run "<prompt>" --format json`) — there is no single fixed slot
   * that works for every provider.
   */
  buildArgs: (prompt: string) => string[];
  /** Host environment variable names to pass into the container, unchanged. */
  envVarsFromHost?: string[];
  /** Host files (e.g. a credentials file) to bind-mount read-only into the container. */
  hostFileMounts?: HostFileMount[];
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
      buildArgs,
      envVarsFromHost = [],
      hostFileMounts = [],
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
      ...hostFileMountArgs(hostFileMounts),
      image,
      command,
      ...buildArgs(input.prompt),
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

function hostFileMountArgs(mounts: HostFileMount[]): string[] {
  return mounts.flatMap(({ hostPath, containerPath }) => ['-v', `${hostPath}:${containerPath}:ro`]);
}
