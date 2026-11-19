export const INVOCATION_STATUSES = ['done', 'completed', 'stuck', 'halted', 'blocked'] as const;

export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

/** Whether an invocation finished the run's work, merged or not. */
export function outcomeIsComplete(status: InvocationStatus): boolean {
  return status === 'done' || status === 'completed';
}
