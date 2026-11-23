import { z } from 'zod';

/** The `owner/repo` a GitHub job works in, shared by orchestration receipts and the GitHub API. */
export interface RepositoryIdentity {
  owner: string;
  repo: string;
}

export const repositoryIdentitySchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .transform((value): RepositoryIdentity => {
    const [owner, repo] = value.split('/');
    return { owner, repo };
  });
