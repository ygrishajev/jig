/**
 * How the engine reacts to a failure: try the step again, stop and wait for a person, or abort
 * the run. A failure is always the failing step's own; it never becomes work for another role.
 */
export type FailureKind = 'retry' | 'block' | 'fatal';

export function isTransient(error: { readonly kind: FailureKind }): boolean {
  return error.kind === 'retry';
}
