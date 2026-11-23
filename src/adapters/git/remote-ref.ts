import { Result } from 'better-result';
import { execa, type Result as ExecaResult, type ResultPromise } from 'execa';

import { retryResult } from '../../failures/retry.js';
import { GitCommandFailed, RemoteUnavailable } from '../../ports/git-failures.js';
import { RunStateConflict } from '../../ports/run-state-failures.js';

type GitResult = ExecaResult<{ reject: false }>;
type RemoteFailure = RunStateConflict | RemoteUnavailable;

export class RemoteRef {
  constructor(
    private readonly repoRoot: string,
    private readonly remote = 'origin',
  ) {}

  async list(refs: string[]): Promise<Result<Map<string, string>, RemoteFailure>> {
    const listed = await this.remoteCall(
      ['ls-remote', '--exit-code', this.remote, ...refs],
      NO_MATCHING_REFS,
    );
    return listed.map((output) => {
      const entries = output.stdout
        .split('\n')
        .filter(Boolean)
        .map((line): [string, string] => {
          const [commit = '', ref = ''] = line.split('\t');
          return [ref, commit];
        });
      return new Map(entries);
    });
  }

  /** A remote operation, retried while the failure looks like the network rather than a conflict. */
  private remoteCall(
    args: string[],
    alsoAcceptedExitCode?: number,
  ): Promise<Result<GitResult, RemoteFailure>> {
    return retryResult(
      async () => {
        const result = await this.git(args);
        if (result.exitCode === 0 || result.exitCode === alsoAcceptedExitCode) {
          return Result.ok(result);
        }
        return Result.err(
          isLeaseRejection(result.stderr)
            ? new RunStateConflict({
                message: `The run's state on ${this.remote} moved since it was loaded: ${result.stderr}`,
              })
            : new RemoteUnavailable({
                message: `git ${args[0]} to ${this.remote} failed: ${result.stderr}`,
              }),
        );
      },
      {
        retries: REMOTE_RETRIES,
        delayMs: REMOTE_RETRY_DELAY_MS,
        shouldRetry: (error) => error._tag === 'RemoteUnavailable',
      },
    );
  }

  private git(args: string[], input?: string): ResultPromise<{ reject: false }> {
    return execa('git', args, {
      cwd: this.repoRoot,
      input,
      reject: false,
      stripFinalNewline: false,
      env: COMMITTER,
    });
  }

  async revision(ref: string): Promise<string | undefined> {
    const parsed = await this.git(['rev-parse', '--verify', '--quiet', ref]);
    return parsed.exitCode === 0 ? parsed.stdout.trim() : undefined;
  }

  async required(
    args: string[],
    input?: string,
    preserveWhitespace = false,
  ): Promise<Result<string, GitCommandFailed>> {
    const result = await this.git(args, input);
    if (result.exitCode === 0)
      return Result.ok(preserveWhitespace ? result.stdout : result.stdout.trim());
    return Result.err(
      new GitCommandFailed({
        message: `git ${args[0]} failed on the run's state: ${result.stderr}`,
        command: `git ${args.join(' ')}`,
        output: result.stderr,
      }),
    );
  }

  fetch(refspecs: string[]): Promise<Result<void, RemoteFailure>> {
    return this.remoteCall(['fetch', '--quiet', this.remote, ...refspecs]).then((result) =>
      result.map(() => undefined),
    );
  }

  /** Fetches objects without moving local refs, including FETCH_HEAD. */
  peek(
    ref: string,
  ): Promise<Result<Map<string, string> | undefined, RemoteFailure | GitCommandFailed>> {
    return Result.gen(async function* (this: RemoteRef) {
      const listed = yield* Result.await(this.list([ref]));
      const commit = listed.get(ref);
      if (!commit) return Result.ok(undefined);
      yield* Result.await(
        this.remoteCall(['fetch', '--quiet', '--no-write-fetch-head', this.remote, ref]),
      );
      const files = yield* Result.await(this.required(['ls-tree', '-r', '--name-only', commit]));
      const contents = new Map<string, string>();
      for (const file of files.split('\n').filter(Boolean)) {
        const shown = yield* Result.await(
          this.required(['show', `${commit}:${file}`], undefined, true),
        );
        contents.set(file, shown);
      }
      return Result.ok(contents);
    }, this);
  }

  pushLeased(
    updates: { ref: string; expected?: string; source: string }[],
  ): Promise<Result<void, RemoteFailure>> {
    return this.remoteCall([
      'push',
      '--quiet',
      '--atomic',
      ...updates.map(({ ref, expected }) => `--force-with-lease=${ref}:${expected ?? ''}`),
      this.remote,
      ...updates.map(({ ref, source }) => `${source}:${ref}`),
    ]).then((result) => result.map(() => undefined));
  }

  commitFile(
    ref: string,
    file: string,
    contents: string,
    message: string,
  ): Promise<Result<string, GitCommandFailed>> {
    return Result.gen(async function* (this: RemoteRef) {
      const blob = yield* Result.await(this.required(['hash-object', '-w', '--stdin'], contents));
      const tree = yield* Result.await(this.required(['mktree'], `100644 blob ${blob}\t${file}\n`));
      const parent = await this.revision(ref);
      const commit = yield* Result.await(
        this.required(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]),
      );
      yield* Result.await(this.required(['update-ref', ref, commit]));
      return Result.ok(commit);
    }, this);
  }
}

/** `git ls-remote --exit-code` exits with this when the remote has none of the refs asked for. */
const NO_MATCHING_REFS = 2;

/** Git reports a push whose lease no longer matches, or that is not a fast-forward, as rejected. */
function isLeaseRejection(stderr: string): boolean {
  return stderr.includes('[rejected]') || stderr.includes('stale info');
}

/** How many more times a fetch or push that failed on the network is tried. */
const REMOTE_RETRIES = 3;

/** The wait before the first retry; each one after it waits twice as long. */
const REMOTE_RETRY_DELAY_MS = 1000;

/** Identity for the state commits; they are jig's bookkeeping, not anyone's work. */
const COMMITTER = {
  GIT_AUTHOR_NAME: 'jig',
  GIT_AUTHOR_EMAIL: 'jig@localhost',
  GIT_COMMITTER_NAME: 'jig',
  GIT_COMMITTER_EMAIL: 'jig@localhost',
};
