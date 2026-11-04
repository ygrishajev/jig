// Runs jig's real session and workspace against real docker, with a scripted agent, no model and
// no credentials. Unit specs fake docker; re-run this when upgrading sandcastle, because the design
// relies on two of its behaviours (see the private clone sandbox spec).
//
//   npx tsx spike/check-private-clone.ts
//   SPIKE_IMAGE=<image> npx tsx spike/check-private-clone.ts
import type { AgentProvider } from '@ai-hero/sandcastle';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';

import { GitWorkspace } from '../src/adapters/git/git-workspace.js';
import { SandcastleSession } from '../src/adapters/sandcastle/sandcastle-session.js';
import { runIdSchema } from '../src/domain/run-id.js';
import { runBranchFor } from '../src/domain/run-state.js';

const IMAGE = process.env.SPIKE_IMAGE ?? 'sandcastle:sdlc-sandcastle';
const run = { runId: runIdSchema.parse('spike'), baseBranch: 'main' };
const branch = runBranchFor(run.runId);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf-8' }).trim();

const results: boolean[] = [];
function check(name: string, passed: boolean, detail = '') {
  results.push(passed);
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function makeRepo() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'jig-spike-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'operator@example.invalid');
  git(dir, 'config', 'user.name', 'operator');
  writeFileSync(path.join(dir, 'README.md'), '# spike\n');
  writeFileSync(path.join(dir, '.gitignore'), '.sandcastle/\n.jig/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'config', 'commit.gpgsign', 'true');
  git(dir, 'config', 'gpg.program', 'false');
  return dir;
}

let script = '';
const scriptedAgent: AgentProvider = {
  name: 'scripted',
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: script }),
  parseStreamLine: (line) => [{ type: 'text', text: line }],
};

const repo = makeRepo();
const configBefore = readFileSync(path.join(repo, '.git/config'), 'utf-8');
const hooksBefore = execFileSync('ls', [path.join(repo, '.git/hooks')], { encoding: 'utf-8' });
writeFileSync(path.join(repo, '.git/info/exclude'), 'local-only.txt\n');
const fork = git(repo, 'rev-parse', 'main');
const logs = mkdtempSync(path.join(tmpdir(), 'jig-spike-logs-'));

const opened = await SandcastleSession.open({
  repoRoot: repo,
  ...run,
  imageName: IMAGE,
  credentials: {},
  agents: {
    planner: scriptedAgent,
    implementer: scriptedAgent,
    reviewer: scriptedAgent,
    describer: scriptedAgent,
  },
  setupTimeoutSeconds: 60,
  idleTimeoutSeconds: 30,
  agentLogFile: path.join(logs, 'agents.log'),
  events: { publish: () => undefined },
  logger: pino({ level: 'silent' }),
});
const session = opened.unwrap();
const workspace = new GitWorkspace({
  repoRoot: repo,
  worktreePath: session.worktreePath,
  sandbox: session,
  ...run,
});
const agentRun = async (commands: string) => {
  script = commands;
  (await session.run({ role: 'implementer', prompt: 'scripted' })).unwrap();
};
const sandboxHead = async () => (await session.execGit(['rev-parse', 'HEAD'])).output.trim();

const container = (await session.exec('hostname')).output;
try {
  check(
    'the container has no mounts',
    docker('inspect', '-f', '{{len .Mounts}}', container) === '0',
  );
  check(
    'the host repository is not in the container',
    (await session.exec(`test -e "${repo}"`)).exitCode !== 0,
  );
  check('the sandbox starts at the fork point', (await sandboxHead()) === fork);
  check('the clone has no remote', (await session.execGit(['remote'])).output.trim() === '');
  await session.exec('echo x > local-only.txt');
  check(
    'local excludes reach the clone',
    !(await session.execGit(['status', '--porcelain'])).output.includes('local-only'),
  );

  await agentRun('echo one > one.txt && git add -A && git commit -qm "slice one"');
  check(
    'the host branch does not move until work is saved',
    git(repo, 'rev-parse', branch) === fork,
  );
  (await workspace.saveWork('unused', { approved: fork })).unwrap();
  const first = await sandboxHead();
  check('saving keeps the SHA', git(repo, 'rev-parse', branch) === first);

  await agentRun('echo two > two.txt');
  (await workspace.saveWork("jig: it's a slice — two", { approved: first })).unwrap();
  const second = await sandboxHead();
  check('uncommitted work is committed in the sandbox', git(repo, 'rev-parse', branch) === second);
  check(
    'the message survives quoting',
    git(repo, 'log', '-1', '--format=%s', branch) === "jig: it's a slice — two",
  );
  check('commits are authored by jig', git(repo, 'log', '-1', '--format=%an', branch) === 'jig');
  check(
    'commits are unsigned though the host signs',
    git(repo, 'log', '-1', '--format=%G?', branch) === 'N',
  );

  await agentRun('echo more >> two.txt && git add -A && git commit -q --amend -m amended');
  const refused = await workspace.saveWork('unused', { approved: second });
  check(
    'rewriting approved work is refused',
    refused.isErr(),
    refused.isErr() ? refused.error._tag : '',
  );
  check('a refusal leaves the host branch alone', git(repo, 'rev-parse', branch) === second);

  const summary = (await workspace.summariseCommitsSince(fork)).unwrap();
  check('the summary reads the host branch', summary.sha === second && summary.filesChanged === 2);
} finally {
  (await session.close()).unwrap();
}

check(
  'close removes the container',
  docker('ps', '-a', '--filter', `id=${container}`, '-q') === '',
);
check('close removes the host worktree', !existsSync(session.worktreePath));
check(
  'the host .git/config is unchanged',
  readFileSync(path.join(repo, '.git/config'), 'utf-8') === configBefore,
);
check(
  'the host hooks are unchanged',
  execFileSync('ls', [path.join(repo, '.git/hooks')], { encoding: 'utf-8' }) === hooksBefore,
);
const merge = (await workspace.mergeRunBranch()).isOk();
check(
  'the run merges into main',
  merge && git(repo, 'status', '--porcelain') === '',
  git(repo, 'log', '-1', '--format=%s'),
);

const failed = results.filter((passed) => !passed).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
