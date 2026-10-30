// Spike checks that need no agent credentials:
//   1. git inside a sandcastle-managed worktree (commit, log, rebase onto a moved base)
//   2. env passed via docker({ env }) reaches the container
//   3. baked UID owns a writable $HOME; agent CLIs run
//   + host side: commits visible after close, operator tree stays clean
//
// Run per scenario, to pin down the symlinked-path bug on any OS:
//   direct            repo opened by its real path                  → expect pass
//   symlink-raw       repo opened through a symlink, path as given  → expect git to fail (the bug)
//   symlink-resolved  same symlink, realpath() applied first        → expect pass (sdlc's fix)
import { createSandbox } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IMAGE = process.env.SPIKE_IMAGE ?? 'sdlc-spike';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function makeRepo(): string {
  // realpath: on macOS tmpdir() is itself under a symlink (/var → /private/var).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sdlc-spike-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'spike@example.com');
  git(dir, 'config', 'user.name', 'spike');
  writeFileSync(path.join(dir, 'README.md'), '# spike\n');
  // What sdlc would write before createSandbox (spec §1).
  mkdirSync(path.join(dir, '.sandcastle'), { recursive: true });
  writeFileSync(path.join(dir, '.sandcastle', '.gitignore'), '*\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function linkTo(target: string): string {
  const linkDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sdlc-spike-link-')));
  const link = path.join(linkDir, 'repo');
  symlinkSync(target, link);
  return link;
}

type Result = { scenario: string; check: string; ok: boolean; detail: string };
const results: Result[] = [];

async function runScenario(
  scenario: string,
  cwd: string,
  expectGit: 'pass' | 'fail',
  full: boolean,
) {
  console.log(`\n=== ${scenario} (cwd: ${cwd}) ===`);
  const record = (check: string, ok: boolean, detail: string) => {
    results.push({ scenario, check, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}\n      ${detail.replace(/\n/g, '\n      ')}`);
  };
  const repo = realpathSync(cwd);
  const branch = `sdlc/run/${scenario}`;

  const sandbox = await createSandbox({
    branch,
    baseBranch: 'main',
    cwd,
    sandbox: docker({ imageName: IMAGE, env: { SPIKE_ENV: 'reached' } }),
  });

  try {
    const sh = (cmd: string) => sandbox.exec(cmd);

    if (full) {
      const who = await sh('echo "uid=$(id -u) gid=$(id -g) home=$HOME pwd=$(pwd)"');
      record(
        'container runs as host uid',
        who.stdout.includes(`uid=${process.getuid?.()} `),
        who.stdout.trim(),
      );
      const home = await sh('mkdir -p "$HOME/.claude" && touch "$HOME/.claude/probe" && echo ok');
      record('$HOME writable', home.exitCode === 0, (home.stdout + home.stderr).trim());
      const clis = await sh('claude --version; opencode --version');
      record('agent CLIs run', clis.exitCode === 0, (clis.stdout + clis.stderr).trim());
      const env = await sh('echo "$SPIKE_ENV"');
      record(
        'docker({ env }) reaches container',
        env.stdout.trim() === 'reached',
        env.stdout.trim() || '(empty)',
      );
    }

    const status = await sh('git status --short --branch && git log --oneline -3');
    const gitWorks = status.exitCode === 0;
    record(
      `git in worktree ${expectGit === 'pass' ? 'works' : 'fails (bug reproduced)'}`,
      expectGit === 'pass' ? gitWorks : !gitWorks,
      (status.stdout + status.stderr).trim(),
    );
    if (expectGit === 'fail') return;

    const commit = await sh(
      'git config user.email agent@example.com && git config user.name agent && ' +
        'echo slice > slice.txt && git add -A && git commit -q -m "slice 1" && git log --oneline -1',
    );
    record(
      'commit inside container',
      commit.exitCode === 0,
      (commit.stdout + commit.stderr).trim(),
    );

    writeFileSync(path.join(repo, `base-${scenario}.txt`), 'moved\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `base moved (${scenario})`);
    const rebase = await sh('git rebase main && git log --oneline -3');
    record('rebase onto moved base', rebase.exitCode === 0, (rebase.stdout + rebase.stderr).trim());
  } finally {
    await sandbox.close();
  }

  const hostLog = git(repo, 'log', '--oneline', `main..${branch}`);
  record('commits visible on host branch', hostLog.includes('slice 1'), hostLog || '(none)');
  const hostStatus = git(repo, 'status', '--porcelain');
  record('operator tree clean', hostStatus === '', hostStatus || '(clean)');
}

console.log(`platform: ${process.platform}, uid: ${process.getuid?.()}, image: ${IMAGE}`);

await runScenario('direct', makeRepo(), 'pass', true);
const linked = linkTo(makeRepo());
await runScenario('symlink-raw', linked, 'fail', false);
await runScenario('symlink-resolved', realpathSync(linked), 'pass', false);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const r of failed) console.log(`  FAILED: [${r.scenario}] ${r.check}`);
process.exitCode = failed.length ? 1 : 0;
