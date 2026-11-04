// The private-clone design's edge cases, with no credentials, no model and no network:
// agent failures, resuming, rewritten history, large inputs, the login mount and repository
// features a bundle may lose. Run after check-private-clone.ts.
import { createSandbox, type Sandbox } from '@ai-hero/sandcastle';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BRANCH,
  check,
  git,
  importFromSandbox,
  makeRepo,
  privateCloneDocker,
  results,
  scriptedAgent,
} from './private-clone.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'jig-import-'));
const run = (sandbox: Sandbox, script: string, idleTimeoutSeconds = 30, stdin?: string) =>
  sandbox.run({
    agent: {
      ...scriptedAgent(script),
      buildPrintCommand: () => ({ command: script, stdin }),
    },
    prompt: 'scripted',
    idleTimeoutSeconds,
  });
const head = async (sandbox: Sandbox) => (await sandbox.exec('git rev-parse HEAD')).stdout.trim();

async function withRun(
  repo: string,
  use: (sandbox: Sandbox, context: { container: string; worktree: string }) => Promise<void>,
  loginMount?: { hostPath: string; sandboxPath: string },
) {
  const state: { container?: string } = {};
  const sandbox = await createSandbox({
    branch: BRANCH,
    baseBranch: 'main',
    cwd: repo,
    sandbox: privateCloneDocker(state, loginMount),
  });
  try {
    await use(sandbox, { container: state.container!, worktree: sandbox.worktreePath });
  } finally {
    await sandbox.close();
  }
}

async function agentFailures() {
  await withRun(makeRepo(), async (sandbox) => {
    const started = Date.now();
    const idle = await run(sandbox, 'echo started; sleep 120', 3).then(
      () => 'finished',
      (error: Error) => error.message,
    );
    const seconds = (Date.now() - started) / 1000;
    check(
      'an idle agent is stopped by the timeout',
      /idle/i.test(idle) && seconds < 30,
      `${seconds.toFixed(0)}s`,
    );
    check(
      'the sandbox still answers after an idle timeout',
      (await sandbox.exec('true')).exitCode === 0,
    );

    const failed = await run(sandbox, 'echo partial; exit 3').then(
      () => 'finished',
      (error: Error) => error.message,
    );
    check('a failing agent is reported as a failure', failed !== 'finished', failed.slice(0, 50));

    const prompt = 'x'.repeat(300_000);
    const large = await run(sandbox, 'wc -c', 30, prompt);
    check(
      'a 300 KB prompt reaches the agent over stdin',
      large.stdout.includes('300000'),
      large.stdout.trim().slice(0, 12),
    );
  });
}

async function streaming() {
  const lines: number[] = [];
  await withRun(makeRepo(), async (sandbox) => {
    await sandbox.run({
      agent: scriptedAgent('echo first; sleep 3; echo second'),
      prompt: 'scripted',
      idleTimeoutSeconds: 30,
      logging: {
        type: 'file',
        path: path.join(scratch, 'agent.log'),
        onAgentStreamEvent: () => lines.push(Date.now()),
      },
    });
  });
  const gap = lines.length > 1 ? (lines.at(-1)! - lines[0]) / 1000 : 0;
  check('agent output streams live', gap >= 2, `${lines.length} events, ${gap.toFixed(1)}s apart`);
}

async function rewrittenHistory() {
  const repo = makeRepo();
  const fork = git(repo, 'rev-parse', 'main');
  await withRun(repo, async (sandbox, { container, worktree }) => {
    const importCommits = (approved: string) =>
      importFromSandbox({ container, hostWorktree: worktree, approved, scratch });
    await run(sandbox, 'echo one > one.txt; git add -A; git commit -qm one');
    const first = await importCommits(fork);
    check('an import with nothing new is a no-op', (await importCommits(fork)) === first);

    await run(sandbox, 'echo more >> one.txt; git add -A; git commit -q --amend -m amended');
    const amended = await importCommits(fork);
    check(
      'amending unapproved work imports',
      amended !== first && amended === (await head(sandbox)),
    );
    check(
      'the host worktree follows the amended work',
      git(worktree, 'status', '--porcelain') === '' && git(repo, 'rev-parse', BRANCH) === amended,
    );

    await run(sandbox, 'echo again >> one.txt; git add -A; git commit -q --amend -m rewritten');
    const refused = await importCommits(amended).then(
      () => false,
      () => true,
    );
    check('rewriting an approved commit is refused', refused);
    check(
      'a refused import leaves the host branch alone',
      git(repo, 'rev-parse', BRANCH) === amended,
    );
    check(
      'a refused import leaves the host worktree clean',
      git(worktree, 'status', '--porcelain') === '',
    );

    const reset = await sandbox.exec(`git reset -q --hard ${amended} && git rev-parse HEAD`);
    check('the sandbox can be reset to the approved commit', reset.stdout.trim() === amended);
  });
}

async function resuming() {
  const repo = makeRepo();
  const fork = git(repo, 'rev-parse', 'main');
  let imported = '';
  await withRun(repo, async (sandbox, { container, worktree }) => {
    await run(
      sandbox,
      'echo one > one.txt; git add -A; git commit -qm one; echo lost > uncommitted.txt',
    );
    imported = await importFromSandbox({
      container,
      hostWorktree: worktree,
      approved: fork,
      scratch,
    });
    await run(sandbox, 'echo unimported > two.txt; git add -A; git commit -qm two');
  });
  check(
    'close with an unimported commit does not move the host branch',
    git(repo, 'rev-parse', BRANCH) === imported,
  );
  await withRun(repo, async (sandbox, { container, worktree }) => {
    check('a resumed run starts from the last imported commit', (await head(sandbox)) === imported);
    check(
      'unimported work is gone on resume',
      (await sandbox.exec('test -e two.txt || test -e uncommitted.txt')).exitCode !== 0,
    );
    await run(sandbox, 'echo three > three.txt; git add -A; git commit -qm three');
    const next = await importFromSandbox({
      container,
      hostWorktree: worktree,
      approved: imported,
      scratch,
    });
    check('a resumed run imports new commits', next === (await head(sandbox)) && next !== imported);
  });
}

async function contents() {
  const repo = makeRepo();
  const fork = git(repo, 'rev-parse', 'main');
  await withRun(repo, async (sandbox, { container, worktree }) => {
    await run(
      sandbox,
      'printf "#!/bin/sh\\n" > tool.sh; chmod +x tool.sh; ln -s README.md link; head -c 20000000 /dev/urandom > big.bin; git add -A; git commit -qm contents',
    );
    const started = Date.now();
    const imported = await importFromSandbox({
      container,
      hostWorktree: worktree,
      approved: fork,
      scratch,
    });
    const seconds = (Date.now() - started) / 1000;
    check('a 20 MB commit imports', imported === (await head(sandbox)), `${seconds.toFixed(1)}s`);
    const tree = git(repo, 'ls-tree', BRANCH);
    check('file modes survive the import', /100755 blob \w+\ttool\.sh/.test(tree));
    check('symbolic links survive the import as links', /120000 blob \w+\tlink/.test(tree));
  });
}

async function setup() {
  await withRun(makeRepo(), async (sandbox) => {
    const ran = await sandbox.exec('node --version && git --version');
    check('a setup-style command runs in the clone', ran.exitCode === 0, ran.stdout.split('\n')[0]);
  });
}

async function loginMount() {
  const login = realpathSync(mkdtempSync(path.join(tmpdir(), 'jig-login-')));
  writeFileSync(path.join(login, 'auth.json'), '{"dummy":true}\n');
  await withRun(
    makeRepo(),
    async (sandbox) => {
      const seen = await sandbox.exec('cat /home/agent/.codex/auth.json');
      check('the login directory is the one mount the sandbox gets', seen.stdout.includes('dummy'));
      const written = await sandbox.exec('echo refreshed > /home/agent/.codex/auth.json');
      check(
        'the sandbox can refresh the mounted login',
        written.exitCode === 0,
        written.stderr.trim(),
      );
    },
    { hostPath: login, sandboxPath: '/home/agent/.codex' },
  );
  check(
    'a refreshed login reaches the host',
    readFileSync(path.join(login, 'auth.json'), 'utf-8').includes('refreshed'),
  );
}

async function localExcludes() {
  const repo = makeRepo();
  const globalIgnore = path.join(mkdtempSync(path.join(tmpdir(), 'jig-ignore-')), 'ignore');
  writeFileSync(globalIgnore, 'global-only.txt\n');
  writeFileSync(path.join(repo, '.git/info/exclude'), 'local-only.txt\n');
  git(repo, 'config', 'core.excludesFile', globalIgnore);
  await withRun(repo, async (sandbox) => {
    await sandbox.exec('echo x > local-only.txt; echo x > global-only.txt; echo x > visible.txt');
    const status = await sandbox.exec('git status --porcelain');
    check(
      '.git/info/exclude reaches the clone',
      !status.stdout.includes('local-only.txt'),
      status.stdout.trim(),
    );
    check('core.excludesFile reaches the clone', !status.stdout.includes('global-only.txt'));
    check('other untracked files still show', status.stdout.includes('visible.txt'));
  });
}

async function submodules() {
  const library = makeRepo();
  const repo = makeRepo();
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'library');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'add submodule');
  const fork = git(repo, 'rev-parse', 'main');
  const worktreeToday = path.join(mkdtempSync(path.join(tmpdir(), 'jig-today-')), 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', worktreeToday, 'main');
  const todayEmpty =
    execFileSync('ls', ['-A', path.join(worktreeToday, 'library')], { encoding: 'utf-8' }) === '';
  check('today a new worktree has an empty submodule too', todayEmpty);
  git(repo, 'worktree', 'remove', '--force', worktreeToday);
  await withRun(repo, async (sandbox, { container, worktree }) => {
    const listed = await sandbox.exec('ls -A library | wc -l');
    check('the clone has the submodule directory, empty', listed.stdout.trim() === '0');
    await run(sandbox, 'echo x > y.txt; git add -A; git commit -qm change');
    const pointer = git(repo, 'ls-tree', 'main', 'library').split(/\s+/)[2];
    await importFromSandbox({ container, hostWorktree: worktree, approved: fork, scratch });
    check(
      'a commit keeps the submodule pointer',
      git(repo, 'ls-tree', BRANCH, 'library').split(/\s+/)[2] === pointer,
    );
  });
}

for (const scenario of [
  agentFailures,
  streaming,
  rewrittenHistory,
  resuming,
  contents,
  setup,
  loginMount,
  localExcludes,
  submodules,
]) {
  await scenario().catch((error: Error) =>
    check(`${scenario.name} ran to the end`, false, error.message.slice(0, 160)),
  );
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
