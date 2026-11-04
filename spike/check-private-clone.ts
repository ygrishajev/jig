// Spike for the private-clone sandbox: no credentials, no model, no network.
//   1. a bind-mount provider can ignore the mounts sandcastle offers and hand the container a clone
//   2. a scripted agent commits in that clone through the normal sandbox.run
//   3. the host imports those commits from a bundle, keeping their SHAs and signing nothing
//   4. sandcastle's own host-side git, close included, still works on the host worktree
import { createSandbox } from '@ai-hero/sandcastle';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BRANCH,
  check,
  docker,
  git,
  importFromSandbox,
  makeRepo,
  privateCloneDocker,
  results,
  scriptedAgent,
} from './private-clone.js';

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
  const importedFirst = await importFromSandbox({
    container,
    hostWorktree,
    approved: fork,
    scratch,
  });
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
    approved: firstHead,
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
