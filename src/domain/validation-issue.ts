import type { z } from 'zod';

/** `path: message`, or the message alone when the issue is about the whole value. */
export function describeIssue({ path, message }: z.ZodIssue): string {
  return path.length > 0 ? `${path.join('.')}: ${message}` : message;
}
