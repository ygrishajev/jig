import type { z } from 'zod';

import { describeIssue } from '../domain/validation-issue.js';

/** Every issue on one line, the one format every config failure uses. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map(describeIssue).join('; ');
}
