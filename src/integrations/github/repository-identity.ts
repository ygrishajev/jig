import { Result } from 'better-result';
import { z } from 'zod';

import { gitCommand, openRepo } from '../../adapters/git/repository.js';
import { GithubSetupInvalid } from './errors.js';
import type { RepositoryIdentity } from './github-port.js';

export async function repositoryIdentity(
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<Result<RepositoryIdentity, GithubSetupInvalid>> {
  const configured = environment.GITHUB_REPOSITORY;
  if (configured !== undefined) return parseRepository(configured);
  const origin = await gitCommand('remote get-url', () =>
    openRepo(repoRoot).remote(['get-url', 'origin']),
  );
  if (origin.isErr())
    return Result.err(
      new GithubSetupInvalid({ message: 'Set GITHUB_REPOSITORY or configure a GitHub origin.' }),
    );
  const name =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^\s]+?)\/?$/.exec(
      origin.value?.trim() ?? '',
    )?.[1];
  return parseRepository(name?.replace(/\.git$/, ''));
}

function parseRepository(value: unknown): Result<RepositoryIdentity, GithubSetupInvalid> {
  const parsed = repositorySchema.safeParse(value);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new GithubSetupInvalid({ message: 'Repository must identify a GitHub owner/repository.' }),
      );
}

const repositorySchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .transform((value): RepositoryIdentity => {
    const [owner, repo] = value.split('/');
    return { owner, repo };
  });
