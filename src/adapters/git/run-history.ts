import { Result } from 'better-result';
import { execa } from 'execa';

import { GitCommandFailed, messageOf } from '../../domain/errors.js';

/** The commit `ref` names exactly, or `undefined` when there is no such ref or commit here. */
export function exactHead(
  repoRoot: string,
  ref: string,
): Promise<Result<string | undefined, GitCommandFailed>> {
  return gitOutput(
    repoRoot,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    [1],
  ).then((result) =>
    result.map(({ stdout, exitCode }) => (exitCode === 0 ? stdout.trim() : undefined)),
  );
}

/** Runs git, accepting exit 0 and `alsoAccepted`; any other exit is the command's failure. */
async function gitOutput(
  repoRoot: string,
  args: string[],
  alsoAccepted: number[] = [],
): Promise<Result<{ stdout: string; exitCode: number }, GitCommandFailed>> {
  const command = `git ${args.join(' ')}`;
  const failure = (output: string): GitCommandFailed =>
    new GitCommandFailed({ message: `${command} failed: ${output}`, command, output });
  const ran = await Result.tryPromise({
    try: () => execa('git', args, { cwd: repoRoot, reject: false, stripFinalNewline: false }),
    catch: (cause) => failure(messageOf(cause)),
  });
  if (ran.isErr()) return Result.err(ran.error);
  const { stdout, stderr, exitCode = -1 } = ran.value;
  if (exitCode === 0 || alsoAccepted.includes(exitCode)) return Result.ok({ stdout, exitCode });
  return Result.err(failure(stderr));
}

/** Whether this repository holds `commit` as an object, whether or not a ref reaches it. */
export function hasCommit(
  repoRoot: string,
  commit: string,
): Promise<Result<boolean, GitCommandFailed>> {
  return gitOutput(repoRoot, ['cat-file', '-e', '--end-of-options', commit], [1]).then((result) =>
    result.map(({ exitCode }) => exitCode === 0),
  );
}

/** The commits `head` has that `start` does not, newest first. */
export function commitsBeyond(
  repoRoot: string,
  start: string,
  head: string,
): Promise<Result<string[], GitCommandFailed>> {
  return gitOutput(repoRoot, ['rev-list', '--end-of-options', `${start}..${head}`]).then((result) =>
    result.map(({ stdout }) => stdout.split('\n').filter(Boolean)),
  );
}

/** Where `head` forked from `defaultHead`, or `undefined` when they share no history. */
export function mergeBaseWith(
  repoRoot: string,
  defaultHead: string,
  head: string,
): Promise<Result<string | undefined, GitCommandFailed>> {
  return gitOutput(repoRoot, ['merge-base', '--end-of-options', defaultHead, head], [1]).then(
    (result) => result.map(({ stdout, exitCode }) => (exitCode === 0 ? stdout.trim() : undefined)),
  );
}

/**
 * Every path whose content or type differs between `from` and `to`. Rename detection is off, so a
 * rename names both its old and its new path, and NUL-delimited output keeps unusual names intact.
 */
export function changedPaths(
  repoRoot: string,
  from: string,
  to: string,
): Promise<Result<string[], GitCommandFailed>> {
  return gitOutput(repoRoot, [
    'diff',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '--name-only',
    '-z',
    '--end-of-options',
    from,
    to,
    '--',
  ]).then((result) => result.map(({ stdout }) => stdout.split('\0').filter(Boolean)));
}
