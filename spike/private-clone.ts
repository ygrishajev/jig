// What the private-clone checks share: the provider, the import and a scripted agent.
import { createBindMountSandboxProvider } from '@ai-hero/sandcastle';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

export const IMAGE = process.env.SPIKE_IMAGE ?? 'sandcastle:sdlc-sandcastle-base';
export const BRANCH = 'jig/run/spike';
export const WORKSPACE = '/home/agent/workspace';
const AGENT_IDENTITY = {
  GIT_AUTHOR_NAME: 'jig',
  GIT_AUTHOR_EMAIL: 'jig@users.noreply.invalid',
  GIT_COMMITTER_NAME: 'jig',
  GIT_COMMITTER_EMAIL: 'jig@users.noreply.invalid',
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim();
export const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf-8' }).trim();

export const results: { name: string; passed: boolean; detail: string }[] = [];
export function check(name: string, passed: boolean, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

export function runInContainer(
  container: string,
  command: string,
  options: { onLine?: (line: string) => void; cwd?: string; stdin?: string } = {},
) {
  const args = ['exec', ...(options.stdin === undefined ? [] : ['-i'])];
  args.push('-w', options.cwd ?? WORKSPACE, container, 'sh', '-c', command);
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      lines.push(line);
      options.onLine?.(line);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout: lines.join('\n'), stderr, exitCode: code ?? 1 }));
    child.stdin.end(options.stdin ?? '');
  });
}

export async function copyBytesOut(container: string, from: string, to: string) {
  const child = spawn('docker', ['exec', container, 'cat', from], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await pipeline(child.stdout, createWriteStream(to, { flags: 'wx', mode: 0o600 }));
}

function hostExcludes(repo: string) {
  const configured = execFileSync('sh', ['-c', 'git config --path core.excludesFile || true'], {
    cwd: repo,
    encoding: 'utf-8',
  }).trim();
  return [path.join(repo, '.git/info/exclude'), configured]
    .filter((file) => file && existsSync(file))
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n');
}

export function privateCloneDocker(
  state: { container?: string; offeredMounts?: unknown[] },
  loginMount?: { hostPath: string; sandboxPath: string },
) {
  return createBindMountSandboxProvider({
    name: 'private-clone-docker',
    sandboxHomedir: '/home/agent',
    create: async ({ hostRepoPath, mounts, env }) => {
      state.offeredMounts = mounts;
      const container = `jig-spike-${randomUUID()}`;
      state.container = container;
      const environment = { ...env, ...AGENT_IDENTITY, HOME: '/home/agent' };
      docker(
        'run',
        '-d',
        '--name',
        container,
        '--network',
        'none',
        '--memory',
        '1g',
        '--pids-limit',
        '256',
        '--security-opt',
        'no-new-privileges',
        ...(loginMount ? ['-v', `${loginMount.hostPath}:${loginMount.sandboxPath}`] : []),
        ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        IMAGE,
        'sleep',
        '600',
      );
      const bundle = path.join(mkdtempSync(path.join(tmpdir(), 'jig-bundle-')), 'in.bundle');
      git(hostRepoPath, 'bundle', 'create', bundle, BRANCH, 'main');
      execFileSync('docker', ['cp', bundle, `${container}:/tmp/in.bundle`]);
      const cloned = await runInContainer(
        container,
        `git clone -q -b ${BRANCH} /tmp/in.bundle ${WORKSPACE} && git -C ${WORKSPACE} branch -q main origin/main && rm /tmp/in.bundle`,
        { cwd: '/' },
      );
      if (cloned.exitCode !== 0) throw new Error(`clone failed: ${cloned.stderr}`);
      const excludes = await runInContainer(container, 'cat > .git/info/exclude', {
        stdin: hostExcludes(hostRepoPath),
      });
      if (excludes.exitCode !== 0) throw new Error(`excludes failed: ${excludes.stderr}`);
      return {
        worktreePath: WORKSPACE,
        exec: (command, options) => runInContainer(container, command, options),
        copyFileIn: async (hostPath, sandboxPath) => {
          execFileSync('docker', ['cp', hostPath, `${container}:${sandboxPath}`]);
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          await mkdir(path.dirname(hostPath), { recursive: true });
          await copyBytesOut(container, sandboxPath, hostPath);
        },
        close: async () => {
          docker('rm', '-f', container);
        },
      };
    },
  });
}

export function scriptedAgent(script: string) {
  return {
    name: 'scripted',
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: script }),
    parseStreamLine: (line: string) => [{ type: 'text' as const, text: line }],
  };
}

/**
 * Everything after `approved` may still change: an agent may amend work a reviewer sent back. The
 * approved commit itself must stay in the history, or the import is refused.
 */
export async function importFromSandbox(input: {
  container: string;
  hostWorktree: string;
  approved: string;
  scratch: string;
}) {
  const head = (await runInContainer(input.container, 'git rev-parse HEAD')).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('the sandbox reported no valid head');
  if (head === git(input.hostWorktree, 'rev-parse', 'HEAD')) return head;
  const bundle = path.join(input.scratch, `${randomUUID()}.bundle`);
  const created = await runInContainer(
    input.container,
    `git bundle create -q /tmp/out.bundle ${BRANCH} ^${input.approved}`,
  );
  if (created.exitCode !== 0) throw new Error(`bundle failed: ${created.stderr}`);
  await copyBytesOut(input.container, '/tmp/out.bundle', bundle);
  git(input.hostWorktree, '-c', 'fetch.fsckObjects=true', 'fetch', '-q', bundle, BRANCH);
  const fetched = git(input.hostWorktree, 'rev-parse', 'FETCH_HEAD');
  if (fetched !== head) throw new Error('the bundle does not hold the reported head');
  git(input.hostWorktree, 'merge-base', '--is-ancestor', input.approved, fetched);
  git(input.hostWorktree, 'reset', '-q', '--hard', fetched);
  return fetched;
}

export function makeRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'jig-spike-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'operator@example.invalid');
  git(dir, 'config', 'user.name', 'operator');
  writeFileSync(path.join(dir, 'README.md'), '# spike\n');
  writeFileSync(path.join(dir, '.gitignore'), '.sandcastle/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'config', 'commit.gpgsign', 'true');
  git(dir, 'config', 'gpg.program', 'false');
  return dir;
}
