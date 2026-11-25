import { Result } from 'better-result';

import { GithubSetupInvalid } from '../../ports/github.js';
import { gitCommand, openRepo } from './repository.js';

/** Reads the `owner/repository` name from the clone's `origin` URL, if that URL is on GitHub. */
export async function githubOriginName(
  repoRoot: string,
): Promise<Result<string | undefined, GithubSetupInvalid>> {
  const origin = await gitCommand('remote get-url', () =>
    openRepo(repoRoot).remote(['get-url', 'origin']),
  );
  if (origin.isErr())
    return Result.err(
      new GithubSetupInvalid({ message: 'Set GITHUB_REPOSITORY or configure a GitHub origin.' }),
    );
  return Result.ok(githubNameIn(origin.value?.trim() ?? ''));
}

/** The `owner/repository` a remote URL names, if it is on GitHub. */
export function githubNameIn(remoteUrl: string): string | undefined {
  return GITHUB_REMOTE_URL.exec(remoteUrl)?.[1]?.replace(/\.git$/, '');
}

/** The HTTPS, scp-style and SSH forms of a GitHub remote, capturing what follows the host. */
const GITHUB_REMOTE_URL =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+?)\/?$/;
