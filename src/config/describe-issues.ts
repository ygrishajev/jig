import type { z } from 'zod';

/** `path: message` for each issue, the one format every config failure uses. */
export function describeIssues(error: z.ZodError, separator = '; '): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join(separator);
}
