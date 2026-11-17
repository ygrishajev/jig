import { Result } from 'better-result';
import { execaSync } from 'execa';
import { constants } from 'node:os';

import type { GitCommandFailed } from '../domain/errors.js';
import { deleteBranch } from './branch.js';
import { gitCommand, openRepo } from './repository.js';

/** The part of `process` that ends it: its exit and signal events, and `exit`. */
export interface ExitingProcess {
  on(event: 'exit', listener: () => void): unknown;
  on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

/**
 * Runs `use`, and removes `branch` and any worktree on it if the process exits first. A signal
 * otherwise ends the process without running `finally`, and sandcastle keeps the worktree on
 * purpose, for a run that can resume; a throwaway branch has nothing to resume. Removing them once
 * `use` finishes is the caller's job (`discardBranch`), where a failure can be reported.
 */
export async function discardBranchOnExit<T>(
  cwd: string,
  branch: string,
  use: () => Promise<T>,
  host: ExitingProcess = process,
): Promise<T> {
  const discard = (): void => discardBranchNow(cwd, branch);
  const exitOnSignal = (signal: NodeJS.Signals): void => host.exit(128 + constants.signals[signal]);
  host.on('exit', discard);
  for (const signal of EXIT_SIGNALS) host.on(signal, exitOnSignal);
  try {
    return await use();
  } finally {
    host.off('exit', discard);
    for (const signal of EXIT_SIGNALS) host.off(signal, exitOnSignal);
  }
}

/** Synchronous, because an `exit` listener cannot wait; nothing is left to report a failure to. */
function discardBranchNow(cwd: string, branch: string): void {
  const listed = execaSync('git', ['worktree', 'list', '--porcelain'], { cwd, reject: false });
  for (const worktree of worktreesOn(String(listed.stdout), branch)) {
    execaSync('git', ['worktree', 'remove', '--force', worktree], { cwd, reject: false });
  }
  execaSync('git', ['branch', '-D', branch], { cwd, reject: false });
}

function worktreesOn(porcelain: string, branch: string): string[] {
  return porcelain.split('\n\n').flatMap((entry) => {
    const lines = entry.split('\n');
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    return worktree && lines.includes(`branch refs/heads/${branch}`) ? [worktree] : [];
  });
}

/**
 * Exiting from a signal is what fires `exit`; without a listener of its own, Ctrl+C before
 * sandcastle registers one would kill the process without it.
 */
const EXIT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Removes `branch` with any worktree still on it: a sandbox's close leaves its worktree in
 * place when the run left uncommitted changes there or when removing it failed, and git
 * refuses to delete a branch a worktree is on.
 */
export async function discardBranch(
  cwd: string,
  branch: string,
): Promise<Result<void, GitCommandFailed>> {
  const removed = await removeWorktreesOn(cwd, branch);
  if (removed.isErr()) return removed;
  return deleteBranch(cwd, branch);
}

async function removeWorktreesOn(
  cwd: string,
  branch: string,
): Promise<Result<void, GitCommandFailed>> {
  return gitCommand('worktree remove', async () => {
    const listed = String(await openRepo(cwd).raw(['worktree', 'list', '--porcelain']));
    for (const worktree of worktreesOn(listed, branch)) {
      await openRepo(cwd).raw(['worktree', 'remove', '--force', worktree]);
    }
  });
}
