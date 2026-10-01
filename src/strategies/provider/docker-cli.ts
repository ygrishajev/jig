import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa, ExecaError } from 'execa';
import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export interface HostFileMount {
  hostPath: string;
  containerPath: string;
}

/**
 * The sandbox's $HOME for every run, regardless of which host (a Mac
 * laptop, a CI runner) is driving it or which uid the container runs as.
 * Fixed rather than mirroring the host's real home path, so it's always a
 * path `run()` can freely create a backing directory for — the host's own
 * home path might not even be a legal/creatable path inside the container
 * (e.g. a macOS-style `/Users/...` path on a Linux image).
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

    // Backs $HOME for this one call. Created fresh (and matches whichever
    // uid is actually running sdlc, since this process creates it) rather
    // than reusing the image's baked-in user, so the container's uid always
    // matches the host's — the bind-mounted cwd (and anything sdlc creates
    // under it mid-run, like a slice's worktree) is owned by the host uid,
    // not by whatever fixed uid the image happens to declare.
    const scratchHome = await mkdtemp(path.join(os.tmpdir(), 'sdlc-sandbox-home-'));
    try {
      // `mkdtemp` defaults to 0700, owned by whatever uid is running sdlc.
      // The `-u <hostUid>:<hostGid>` below only actually lands as that same
      // uid *inside* the container on a plain, non-remapped dockerd (true on
      // GitHub-hosted runners). A self-hosted runner's docker is often
      // rootless or has userns-remap enabled, which maps that uid onto a
      // different uid on the host side — so the container no longer owns
      // this directory, and e.g. opencode's own writes under $HOME (like
      // creating its repos cache dir) get EACCES despite the uid flag
      // matching in appearance. Since this directory is a throwaway backing
      // store removed right after the run, opening it up to any uid is a
      // cheap way to stay correct regardless of how the host's docker
      // remaps container identities.
      await chmod(scratchHome, 0o777);
      await prepareHostFileMountDirs(scratchHome, hostFileMounts);
      const { uid, gid } = os.userInfo();
      const dockerArgs = [
        'run',
        '--rm',
        '-u',
        `${uid}:${gid}`,
        '-e',
        `HOME=${SANDBOX_HOME}`,
        '-v',
        `${scratchHome}:${SANDBOX_HOME}`,
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
    } finally {
      await rm(scratchHome, { recursive: true, force: true });
    }
  }
}

/**
 * For a host file mount landing inside SANDBOX_HOME (e.g. a credential at
 * `${SANDBOX_HOME}/.local/share/opencode/auth.json`), pre-creates that
 * file's parent directory on the scratch home *before* docker runs —
 * owned by the current process's own uid, i.e. the same uid the container
 * is about to run as. Skipped for a mount outside SANDBOX_HOME: nothing
 * here backs that path, so there's no parent on the scratch home to make.
 *
 * Otherwise, Docker itself creates that missing parent at container start,
 * owned by root (since the daemon does it, not the container's own
 * process) — blocking the very writes this exists to allow, e.g. opencode
 * needing to write its own cache dir alongside the mounted auth.json.
 */
async function prepareHostFileMountDirs(
  scratchHome: string,
  mounts: HostFileMount[],
): Promise<void> {
  for (const mount of mounts) {
    if (!mount.containerPath.startsWith(`${SANDBOX_HOME}/`)) continue;
    const relativeDir = path.relative(SANDBOX_HOME, path.dirname(mount.containerPath));
    await mkdir(path.join(scratchHome, relativeDir), { recursive: true });
    // `mkdir`'s `mode` is masked by the process umask, so a freshly created
    // nested dir (e.g. .local/share/opencode) typically ends up 0755 —
    // writable only by its owner. Walk back up to chmod every segment this
    // call created, for the same remapped-uid reason `scratchHome` itself is
    // opened up above: a sibling write under here (opencode creating its
    // repos cache dir next to the mounted auth.json) must work no matter
    // which uid the container is actually seen as on the host.
    let dir = scratchHome;
    for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
      dir = path.join(dir, segment);
      await chmod(dir, 0o777);
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
