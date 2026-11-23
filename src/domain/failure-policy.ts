export type FailureKind = 'retry' | 'block' | 'fatal';

export function isTransient(error: { readonly kind: FailureKind }): boolean {
  return error.kind === 'retry';
}
