import {
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type BindMountSandboxProvider,
  createBindMountSandboxProvider,
} from '@ai-hero/sandcastle';
import { Result } from 'better-result';
import { execa, execaSync } from 'execa';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { GitCommandFailed, messageOf } from '../../domain/errors.js';
import { openRepo } from '../../git/repository.js';

export interface PrivateCloneOptions {
  imageName: string;
  branch: string;
  baseBranch: string;
  env?: Record<string, string>;
  /** The Codex login, the one thing on the host a sandbox still sees. */
  loginDirectory?: string;
  docker?: DockerCli;
  copyLimitBytes?: number;
}

/** The docker commands a private clone needs; a spec stands in for them, as docker is not there. */
export interface DockerCli {
  run(args: string[], options?: DockerRunOptions): Promise<DockerRunResult>;
  copyIn(hostPath: string, target: string): Promise<void>;
  stream(args: string[]): { stdout: Readable; finished: Promise<number> };
  remove(container: string): Promise<void>;
  /** Removes the container if jig exits first; the returned function cancels that. */
  removeOnExit(container: string): () => void;
}

export interface DockerRunOptions {
  stdin?: string;
  onLine?: (line: string) => void;
}

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PrivateClone {
  provider: BindMountSandboxProvider;
  /** What the provider does when sandcastle asks it for a sandbox. */
  create(options: BindMountCreateOptions): Promise<BindMountSandboxHandle>;
  copyOut(sandboxPath: string, hostPath: string): Promise<Result<void, GitCommandFailed>>;
}

/**
 * A docker sandbox that shares nothing of the repository with the host. Sandcastle offers the
 * worktree and `.git` as mounts and they are ignored: the container gets its own clone of the run
 * and base branches, so nothing it does can reach git state the host later runs git on. Sandcastle
 * keeps its worktree on the host, where its own git commands stay out of the sandbox's reach. See
 * `docs/superpowers/specs/2026-11-04-private-clone-sandbox-design.md`.
 */
export function privateCloneDocker(options: PrivateCloneOptions): PrivateClone {
  const docker = options.docker ?? realDocker;
  const container = `jig-sandbox-${randomUUID()}`;
  const copyLimit = options.copyLimitBytes ?? COPY_LIMIT_BYTES;
  const create = ({ hostRepoPath, env }: BindMountCreateOptions): Promise<BindMountSandboxHandle> =>
    startWithClone({ ...options, docker, container, hostRepoPath, env });
  return {
    provider: createBindMountSandboxProvider({
      name: 'jig-private-clone',
      env: options.env,
      sandboxHomedir: SANDBOX_HOME,
      create,
    }),
    create,
    copyOut: (sandboxPath, hostPath) =>
      copyBytesOut(docker, container, sandboxPath, hostPath, copyLimit),
  };
}

const realDocker: DockerCli = {
  run: async (args, { stdin, onLine } = {}) => {
    const { exitCode, stdout, stderr } = await execa('docker', args, {
      reject: false,
      input: stdin,
      maxBuffer: 256 * 1024 ** 2,
      stdout: onLine
        ? function* (line: unknown) {
            onLine(String(line));
            yield line;
          }
        : 'pipe',
    });
    return { exitCode: exitCode ?? 1, stdout, stderr };
  },
  copyIn: async (hostPath, target) => {
    await execa('docker', ['cp', hostPath, target]);
  },
  stream: (args) => {
    const subprocess = execa('docker', args, { reject: false, buffer: false, stderr: 'ignore' });
    return {
      stdout: subprocess.stdout,
      finished: subprocess.then(({ exitCode }) => exitCode ?? 1),
    };
  },
  remove: async (container) => {
    await execa('docker', ['rm', '-f', container], { reject: false });
  },
  removeOnExit: (container) => {
    const removeNow = (): void => {
      execaSync('docker', ['rm', '-f', container], { reject: false, stdio: 'ignore' });
    };
    process.on('exit', removeNow);
    return () => process.off('exit', removeNow);
  },
};

/** Far more than a run's commits should ever be; stops a sandbox from filling the host's disk. */
const COPY_LIMIT_BYTES = 2 * 1024 ** 3;

async function startWithClone(input: {
  docker: DockerCli;
  container: string;
  imageName: string;
  branch: string;
  baseBranch: string;
  loginDirectory?: string;
  hostRepoPath: string;
  env: Record<string, string>;
}): Promise<BindMountSandboxHandle> {
  const { docker, container } = input;
  await mustSucceed(docker.run(containerArguments(input)));
  const cancelRemoveOnExit = docker.removeOnExit(container);
  let ready = false;
  try {
    await copyBundleIn(input);
    await mustSucceed(docker.run(inContainer(container, '/', cloneCommand(input))));
    await mustSucceed(
      docker.run(inContainer(container, SANDBOX_WORKSPACE, 'cat > .git/info/exclude', true), {
        stdin: await hostExcludes(input.hostRepoPath),
      }),
    );
    ready = true;
  } finally {
    if (!ready) {
      cancelRemoveOnExit();
      await docker.remove(container);
    }
  }
  return {
    worktreePath: SANDBOX_WORKSPACE,
    exec: (command, { onLine, cwd, sudo, stdin } = {}) =>
      docker.run(
        inContainer(
          container,
          cwd ?? SANDBOX_WORKSPACE,
          sudo ? `sudo ${command}` : command,
          stdin !== undefined,
        ),
        { onLine, stdin },
      ),
    copyFileIn: (hostPath, sandboxPath) => docker.copyIn(hostPath, `${container}:${sandboxPath}`),
    copyFileOut: async (sandboxPath, hostPath) => {
      const copied = await copyBytesOut(docker, container, sandboxPath, hostPath, COPY_LIMIT_BYTES);
      if (copied.isErr()) return Promise.reject(copied.error);
    },
    close: async () => {
      cancelRemoveOnExit();
      await docker.remove(container);
    },
  };
}

/** Sandcastle's provider contract reports a failed start by rejecting. */
async function mustSucceed(running: Promise<DockerRunResult>): Promise<void> {
  const { exitCode, stderr } = await running;
  if (exitCode !== 0) {
    return Promise.reject(new Error(`docker failed (exit ${exitCode}): ${stderr.trim()}`));
  }
}

function containerArguments(input: {
  container: string;
  imageName: string;
  loginDirectory?: string;
  env: Record<string, string>;
}): string[] {
  const environment = { ...input.env, ...AGENT_IDENTITY, HOME: SANDBOX_HOME };
  return [
    'run',
    '-d',
    '--name',
    input.container,
    ...(process.getuid && process.getgid
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : []),
    ...(input.loginDirectory ? ['-v', `${input.loginDirectory}:${SANDBOX_CODEX_DIRECTORY}:z`] : []),
    ...Object.entries(environment).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    input.imageName,
  ];
}

/** Set in the container so they override the `user.name` sandcastle copies in from the host. */
const AGENT_IDENTITY = {
  GIT_AUTHOR_NAME: 'jig',
  GIT_AUTHOR_EMAIL: 'jig@users.noreply.invalid',
  GIT_COMMITTER_NAME: 'jig',
  GIT_COMMITTER_EMAIL: 'jig@users.noreply.invalid',
};

const SANDBOX_HOME = '/home/agent';

const SANDBOX_CODEX_DIRECTORY = `${SANDBOX_HOME}/.codex`;

/** Only the two branches a run needs, so the rest of the repository's history stays on the host. */
async function copyBundleIn(input: {
  docker: DockerCli;
  container: string;
  branch: string;
  baseBranch: string;
  hostRepoPath: string;
}): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'jig-bundle-'));
  try {
    const bundle = path.join(directory, 'in.bundle');
    await openRepo(input.hostRepoPath).raw([
      'bundle',
      'create',
      bundle,
      input.branch,
      input.baseBranch,
    ]);
    await input.docker.copyIn(bundle, `${input.container}:${INCOMING_BUNDLE}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const INCOMING_BUNDLE = '/tmp/in.bundle';

function inContainer(container: string, cwd: string, command: string, keepStdin = false): string[] {
  return ['exec', ...(keepStdin ? ['-i'] : []), '-w', cwd, container, 'sh', '-c', command];
}

/** Drops the remote afterwards: it names a file that is gone, and agents have nowhere to push. */
function cloneCommand({ branch, baseBranch }: { branch: string; baseBranch: string }): string {
  return [
    `git clone -q -b ${shellQuote(branch)} ${INCOMING_BUNDLE} ${SANDBOX_WORKSPACE}`,
    `git -C ${SANDBOX_WORKSPACE} branch -q ${shellQuote(baseBranch)} ${shellQuote(`origin/${baseBranch}`)}`,
    `git -C ${SANDBOX_WORKSPACE} remote remove origin`,
    `rm -f ${INCOMING_BUNDLE}`,
  ].join(' && ');
}

export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

const SANDBOX_WORKSPACE = `${SANDBOX_HOME}/workspace`;

/** Without these, `git add -A` in the sandbox would commit files the operator's git ignores. */
async function hostExcludes(repoRoot: string): Promise<string> {
  const configured = await openRepo(repoRoot)
    .raw(['config', '--path', 'core.excludesFile'])
    .catch(() => '');
  const files = [
    path.join(repoRoot, '.git', 'info', 'exclude'),
    configured.trim() || path.join(homedir(), '.config', 'git', 'ignore'),
  ];
  return files
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n');
}

/**
 * Bytes through `cat`, never `docker cp`: that could bring a symbolic link across, and whatever
 * the sandbox put at this path, the host ends up with a new regular file of its own.
 */
async function copyBytesOut(
  docker: DockerCli,
  container: string,
  sandboxPath: string,
  hostPath: string,
  limit: number,
): Promise<Result<void, GitCommandFailed>> {
  const failed = (reason: string): GitCommandFailed =>
    new GitCommandFailed({
      message: `Could not copy ${sandboxPath} out of the sandbox: ${reason}`,
      command: `docker exec ${container} cat -- ${sandboxPath}`,
      output: reason,
    });
  const { stdout, finished } = docker.stream([
    'exec',
    '-w',
    SANDBOX_WORKSPACE,
    container,
    'cat',
    '--',
    sandboxPath,
  ]);
  const copied = await Result.tryPromise({
    try: () =>
      pipeline(stdout, limitedTo(limit), createWriteStream(hostPath, { flags: 'wx', mode: 0o600 })),
    catch: (cause) => failed(messageOf(cause)),
  });
  const exitCode = await finished;
  if (copied.isOk() && exitCode === 0) return Result.ok();
  if (!isAlreadyThere(copied)) await rm(hostPath, { force: true });
  return Result.err(copied.isErr() ? copied.error : failed(`cat exited with ${exitCode}`));
}

function limitedTo(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new Error(`it is larger than ${limit} bytes`));
      else done(null, chunk);
    },
  });
}

function isAlreadyThere(copied: Result<void, GitCommandFailed>): boolean {
  return copied.isErr() && copied.error.output.includes('EEXIST');
}
