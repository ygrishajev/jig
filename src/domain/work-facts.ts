import { z } from 'zod';

/** Where a repository stood when it was observed: its head, the content that head holds, and whether anything was left uncommitted. */
export const gitFactsSchema = z.object({
  commit: z.string().min(1),
  tree: z.string().min(1),
  clean: z.boolean(),
});

export type GitFacts = z.infer<typeof gitFactsSchema>;

/** Where the run's work stood when it was observed: the host's run branch and the sandbox clone beside it. */
export const workFactsSchema = z.object({
  host: gitFactsSchema,
  sandbox: gitFactsSchema,
});

export type WorkFacts = z.infer<typeof workFactsSchema>;

/** Where the work stood before and after an operation, so mutation during it cannot hide. */
export const workObservationsSchema = z.object({
  before: workFactsSchema,
  after: workFactsSchema,
});

export type WorkObservations = z.infer<typeof workObservationsSchema>;

/** The exact work a piece of recorded evidence vouches for: a commit and the tree it holds. */
export const checkedWorkSchema = z.object({
  commit: z.string().min(1),
  tree: z.string().min(1),
});

export type CheckedWork = z.infer<typeof checkedWorkSchema>;
