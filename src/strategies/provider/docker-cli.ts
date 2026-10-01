import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { execa, ExecaError } from 'execa';
import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export interface HostEnvFileMount {
  /** A file on the host whose contents become an env var's value, e.g. a credentials file. */
  hostPath: string;
  /** The env var name the container sees, with the file's contents as its value. */
  envVarName: string;
}

/**
 * The sandbox's $HOME for every run, regardless of which host (a Mac
 * laptop, a CI runner) is driving it or which uid the container runs as.
 * Backed by a tmpfs (see `run()`) rather than any host-side directory, so
 * there's never a host path for `run()` to create, own correctly, or for a
 * nested-in-a-container CI runner to fail to see.
 */
export const SANDBOX_HOME = '/home/sandbox';

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
  /**
   * Host files (e.g. a credentials file) whose contents are passed into the
   * container as an env var — not bind-mounted. $HOME is a tmpfs with
   * nothing backing it on the host, so there's no path to mount a file
   * into; the image's own entrypoint (docker/agent-sandbox/entrypoint.sh)
   * writes the value to the file a provider's CLI actually expects.
   */
  hostEnvFileMounts?: HostEnvFileMount[];
  /**
   * 'always' re-checks the registry for a newer image on every run, instead
   * of docker's own default of reusing whatever's already cached locally
   * under that tag. Needed for a registry-backed image (e.g.
   * SDLC_AGENT_SANDBOX_IMAGE in CI): a GitHub-hosted runner's image cache is
   * empty on every job anyway, but a self-hosted runner keeps its cache
   * across runs, so without this it would silently keep using a stale
   * `:latest` forever once pulled once — never left unset by a caller using
   * a registry image, but defaults to 'missing' (docker's own default) so a
   * locally `docker build`-tagged image (no registry behind it at all) isn't
   * broken by a pull attempt that can only fail.
   */
  pullPolicy?: 'always' | 'missing';
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
      hostEnvFileMounts = [],
      pullPolicy = 'missing',
      timeoutMs,
      dockerCommand = 'docker',
    } = this.options;

    try {
      const { uid, gid } = os.userInfo();
      const dockerArgs = [
        'run',
        '--rm',
        '--pull',
        pullPolicy,
        '-u',
        `${uid}:${gid}`,
        '-e',
        `HOME=${SANDBOX_HOME}`,
        // A daemon-managed tmpfs, not a host bind mount: whichever uid the
        // container actually runs as (the `-u` above only lands as the real
        // host uid on a plain, non-remapped dockerd — a self-hosted
        // runner's docker is often rootless or userns-remapped, and a
        // containerized runner may not even see a host tmp path the same
        // way the real daemon does) can write here regardless, since the
        // daemon creates it directly with `mode=1777` rather than this
        // process trying to pre-create and own a directory on disk.
        '--tmpfs',
        `${SANDBOX_HOME}:mode=1777`,
        '-v',
        `${input.cwd}:/workspace`,
        '-w',
        '/workspace',
        ...hostEnvArgs(envVarsFromHost),
        ...(await hostEnvFileArgs(hostEnvFileMounts)),
        image,
        command,
        ...buildArgs(input.prompt),
      ];
      // Piped through live (in addition to the normal buffering execa does
      // for the awaited result below) so a long call's progress is visible
      // as it happens — in a local terminal, or in CI, where the job log
      // streams whatever this process prints in real time. Without this, a
      // slow-but-working agent and a genuinely hung one look identical
      // until the call finally returns.
      const subprocess = execa(dockerCommand, dockerArgs, { timeout: timeoutMs, reject: false });
      subprocess.stdout?.pipe(process.stdout);
      subprocess.stderr?.pipe(process.stderr);
      const result = await subprocess;
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

async function hostEnvFileArgs(mounts: HostEnvFileMount[]): Promise<string[]> {
  const args: string[] = [];
  for (const { hostPath, envVarName } of mounts) {
    const value = await readFile(hostPath, 'utf-8');
    args.push('-e', `${envVarName}=${value}`);
  }
  return args;
}
