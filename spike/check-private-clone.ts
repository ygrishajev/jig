// Spike for the private-clone sandbox: no credentials, no model, no network.
//   1. a bind-mount provider can ignore the mounts sandcastle offers and hand the container a clone
//   2. a scripted agent commits in that clone through the normal sandbox.run
//   3. the host imports those commits from a bundle, keeping their SHAs and signing nothing
//   4. sandcastle's own host-side git, close included, still works on the host worktree
import { createBindMountSandboxProvider, createSandbox } from '@ai-hero/sandcastle';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

const IMAGE = process.env.SPIKE_IMAGE ?? 'sandcastle:sdlc-sandcastle-base';
const BRANCH = 'jig/run/spike';
const WORKSPACE = '/home/agent/workspace';
const AGENT_IDENTITY = {
  GIT_AUTHOR_NAME: 'jig',
  GIT_AUTHOR_EMAIL: 'jig@users.noreply.invalid',
  GIT_COMMITTER_NAME: 'jig',
  GIT_COMMITTER_EMAIL: 'jig@users.noreply.invalid',
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf-8' }).trim();

const results: { name: string; passed: boolean; detail: string }[] = [];
function check(name: string, passed: boolean, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function runInContainer(
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

async function copyBytesOut(container: string, from: string, to: string) {
  const child = spawn('docker', ['exec', container, 'cat', from], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await pipeline(child.stdout, createWriteStream(to, { flags: 'wx', mode: 0o600 }));
}

function privateCloneDocker(state: { container?: string; offeredMounts?: unknown[] }) {
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

function scriptedAgent(script: string) {
  return {
    name: 'scripted',
    env: {},
    captureSessions: false,
    buildPrintCommand: () => ({ command: script }),
    parseStreamLine: (line: string) => [{ type: 'text' as const, text: line }],
  };
}

async function importFromSandbox(input: {
  container: string;
  hostWorktree: string;
  since: string;
  scratch: string;
}) {
  const bundle = path.join(input.scratch, `${randomUUID()}.bundle`);
  const created = await runInContainer(
    input.container,
    `git bundle create -q /tmp/out.bundle ${BRANCH} ^${input.since}`,
  );
  if (created.exitCode !== 0) throw new Error(`bundle failed: ${created.stderr}`);
  await copyBytesOut(input.container, '/tmp/out.bundle', bundle);
  git(input.hostWorktree, '-c', 'fetch.fsckObjects=true', 'fetch', '-q', bundle, BRANCH);
  git(input.hostWorktree, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  return git(input.hostWorktree, 'rev-parse', 'HEAD');
}

function makeRepo() {
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

const repo = makeRepo();
const scratch = mkdtempSync(path.join(tmpdir(), 'jig-import-'));
const configBefore = readFileSync(path.join(repo, '.git/config'), 'utf-8');
const hooksBefore = execFileSync('ls', [path.join(repo, '.git/hooks')], { encoding: 'utf-8' });
const state: { container?: string; offeredMounts?: unknown[] } = {};
const fork = git(repo, 'rev-parse', 'main');

const sandbox = await createSandbox({
  branch: BRANCH,
  baseBranch: 'main',
  cwd: repo,
  sandbox: privateCloneDocker(state),
});
try {
  const container = state.container!;
  const hostWorktree = sandbox.worktreePath;
  check(
    'sandcastle offered mounts the provider ignored',
    (state.offeredMounts ?? []).length > 0,
    JSON.stringify((state.offeredMounts ?? []).length),
  );
  check(
    'the container has no mounts',
    docker('inspect', '-f', '{{len .Mounts}}', container) === '0',
  );
  const seesHost = await sandbox.exec(`test -e "${repo}"`);
  check('the host repository path does not exist in the container', seesHost.exitCode !== 0);
  check(
    'sandbox starts at the fork point',
    (await sandbox.exec('git rev-parse HEAD')).stdout.trim() === fork,
  );

  const first = await sandbox.run({
    agent: scriptedAgent(
      `echo one > one.txt && git add -A && git commit -qm "slice one" && echo committed`,
    ),
    prompt: 'scripted',
    idleTimeoutSeconds: 30,
  });
  check(
    'sandbox.run works with the scripted agent',
    first.stdout.includes('committed'),
    first.stdout.trim().slice(0, 40),
  );
  const firstHead = (await sandbox.exec('git rev-parse HEAD')).stdout.trim();
  check(
    'the host did not see the commit before importing',
    git(repo, 'rev-parse', BRANCH) === fork,
  );
  const importedFirst = await importFromSandbox({ container, hostWorktree, since: fork, scratch });
  check('import keeps the SHA', importedFirst === firstHead, importedFirst.slice(0, 10));

  await sandbox.run({
    agent: scriptedAgent('echo two > two.txt'),
    prompt: 'scripted',
    idleTimeoutSeconds: 30,
  });
  const committed = await sandbox.exec(`git add -A && git commit -qm "jig: implement slice two"`);
  check(
    "jig can commit an agent's uncommitted work inside the sandbox",
    committed.exitCode === 0,
    committed.stderr.trim(),
  );
  const secondHead = (await sandbox.exec('git rev-parse HEAD')).stdout.trim();
  const importedSecond = await importFromSandbox({
    container,
    hostWorktree,
    since: firstHead,
    scratch,
  });
  check(
    'a second import carries only the new commit and keeps its SHA',
    importedSecond === secondHead,
  );

  const range = await sandbox.exec(`git rev-list --count ${firstHead}..HEAD`);
  check(
    'host SHAs resolve inside the sandbox, so review ranges still work',
    range.stdout.trim() === '1',
  );
  const reviewNoChange = await sandbox.run({
    agent: scriptedAgent('echo reviewed'),
    prompt: 'scripted',
    idleTimeoutSeconds: 30,
  });
  check(
    'a read-only step leaves the head alone',
    reviewNoChange.stdout.includes('reviewed') &&
      (await sandbox.exec('git rev-parse HEAD')).stdout.trim() === secondHead,
  );

  check('commits are authored by jig', git(repo, 'log', '-1', '--format=%an', BRANCH) === 'jig');
  check(
    'commits are unsigned even though the host signs by default',
    git(repo, 'log', '-1', '--format=%G?', BRANCH) === 'N',
  );
} finally {
  const closed = await sandbox.close();
  check(
    'close removes the host worktree',
    closed.preservedWorktreePath === undefined,
    String(closed.preservedWorktreePath),
  );
}

check(
  'the host .git/config is byte-identical',
  readFileSync(path.join(repo, '.git/config'), 'utf-8') === configBefore,
);
check(
  'the host .git/hooks listing is unchanged',
  execFileSync('ls', [path.join(repo, '.git/hooks')], { encoding: 'utf-8' }) === hooksBefore,
);
git(repo, 'merge', '-q', '--ff-only', BRANCH);
check('the run branch merges into main', git(repo, 'rev-list', '--count', `${fork}..main`) === '2');
check('the operator tree stays clean', git(repo, 'status', '--porcelain') === '');
const stray = docker('ps', '-a', '--filter', `name=${state.container}`, '--format', '{{.Names}}');
check('no container is left behind', stray === '');

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
