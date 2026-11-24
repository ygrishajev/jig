import { Result } from 'better-result';
import { z } from 'zod';

import {
  type RepositoryIdentity,
  repositoryIdentitySchema,
} from '../domain/repository-identity.js';
import { GithubSettingsInvalid } from './errors.js';

/** What implementing a GitHub issue needs from outside: a token and the repository it is about. */
export interface GithubSettings {
  token: string;
  repository: RepositoryIdentity;
}

/**
 * `GITHUB_TOKEN` wins over `GH_TOKEN`, and `GITHUB_REPOSITORY` over the clone's origin, which is
 * asked for only when the variable is unset. The token is checked before the repository is.
 */
export function githubSettingsFrom<DiscoveryFailure>(
  environment: Readonly<Record<string, string | undefined>>,
  originName: () => Promise<Result<string | undefined, DiscoveryFailure>>,
): Promise<Result<GithubSettings, GithubSettingsInvalid | DiscoveryFailure>> {
  return Result.gen(async function* () {
    const parsed = githubEnvironmentSchema.safeParse(environment);
    if (!parsed.success)
      return Result.err(
        new GithubSettingsInvalid({
          message: parsed.error.issues.map(({ message }) => message).join('; '),
        }),
      );
    const { token, GITHUB_REPOSITORY } = parsed.data;
    const name = GITHUB_REPOSITORY ?? (yield* Result.await(originName()));
    const repository = yield* repositoryNamed(name);
    return Result.ok({ token, repository });
  });
}

const githubEnvironmentSchema = z
  .object({
    GITHUB_TOKEN: z.string().min(1).optional(),
    GH_TOKEN: z.string().min(1).optional(),
    GITHUB_REPOSITORY: z.string().optional(),
  })
  .transform(({ GITHUB_TOKEN, GH_TOKEN, GITHUB_REPOSITORY }, context) => {
    const token = GITHUB_TOKEN ?? GH_TOKEN;
    if (!token) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Set GITHUB_TOKEN or GH_TOKEN to implement a GitHub issue.',
      });
      return z.NEVER;
    }
    return { token, GITHUB_REPOSITORY };
  });

function repositoryNamed(
  name: string | undefined,
): Result<RepositoryIdentity, GithubSettingsInvalid> {
  const parsed = repositoryIdentitySchema.safeParse(name);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new GithubSettingsInvalid({
          message: 'Repository must identify a GitHub owner/repository.',
        }),
      );
}
