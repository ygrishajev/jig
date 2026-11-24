import { Result } from 'better-result';

import type { WarningLog } from '../ports/observability.js';
import {
  type HeldPublication,
  PublicationInProgress,
  type PublicationOwnership,
  type ReceiptStoreFailure,
} from '../ports/publication-receipts.js';
import { reportCleanup } from './report-cleanup.js';

/**
 * Runs `step` only while this job still owns the publication, renewing its lease first, so a job
 * whose lease another job took over stops before its next outward-facing effect.
 */
export type WhileOwned = <T, E>(
  step: () => Promise<Result<T, E>>,
) => Promise<Result<T, E | ReceiptStoreFailure | PublicationInProgress>>;

/**
 * Runs `use` as the only job publishing `key`, under a lease another job may take over once it
 * expires. `use` renews the lease through `whileOwned` before each effect, and the lease is
 * released however `use` ends, a panic included.
 */
export async function withPublicationOwnership<T, E>(
  ownership: PublicationOwnership,
  key: string,
  log: WarningLog,
  use: (whileOwned: WhileOwned) => Promise<Result<T, E>>,
): Promise<Result<T, E | ReceiptStoreFailure | PublicationInProgress>> {
  const claimed = await ownership.claim(key);
  if (claimed.isErr()) return Result.err(claimed.error);
  const held = claimed.value;
  if (!held)
    return Result.err(
      new PublicationInProgress({
        message: `Another job is publishing ${key}; run the command again once it finishes.`,
      }),
    );
  const whileOwned: WhileOwned = async (step) => {
    const renewed = await renewOwnership(ownership, held);
    return renewed.isErr() ? Result.err(renewed.error) : step();
  };
  let used: Result<T, E>;
  let released: Result<void, ReceiptStoreFailure>;
  try {
    used = await use(whileOwned);
  } finally {
    released = await ownership.release(held);
  }
  return reportCleanup(used, released, log);
}

async function renewOwnership(
  ownership: PublicationOwnership,
  held: HeldPublication,
): Promise<Result<void, ReceiptStoreFailure | PublicationInProgress>> {
  const renewed = await ownership.renew(held);
  if (renewed.isErr()) return Result.err(renewed.error);
  if (renewed.value) return Result.ok();
  return Result.err(
    new PublicationInProgress({
      message: `Another job took over publishing ${held.key} after this job's lease expired; this job stopped publishing.`,
    }),
  );
}
