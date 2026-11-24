import { z } from 'zod';

export interface RepositoryIdentity {
  owner: string;
  repo: string;
}

/** A GitHub `owner/repository` name, refusing anything that could escape that shape. */
export const repositoryIdentitySchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .transform((value): RepositoryIdentity => {
    const [owner, repo] = value.split('/');
    return { owner, repo };
  });
