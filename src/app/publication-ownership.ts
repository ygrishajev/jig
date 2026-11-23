import { Result } from 'better-result';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

import {
  claimPublication,
  ownsPublication,
  type PublicationOwnership,
  releasePublication,
  renewPublication,
} from '../domain/github-orchestration.js';
import type { Clock } from '../ports/observability.js';
import {
  PublicationInProgress,
  type PublicationReceipts,
  type ReceiptsFailure,
  type WhileOwned,
} from '../ports/publication-receipts.js';
import { reportCleanup } from './report-cleanup.js';

export interface PublicationOwnershipDependencies {
  receipts: PublicationReceipts;
  clock: Clock;
  logger: Logger;
}

/**
 * Runs `use` as the only job publishing `key`, under a lease another job may take over once it
 * expires. `use` renews the lease through `whileOwned` before each effect, and the lease is
 * released however `use` ends, a panic included. A failed release replaces success and is logged
 * after a failure.
 */
export async function withPublicationOwnership<T, E>(
  { receipts, clock, logger }: PublicationOwnershipDependencies,
  key: string,
  use: (whileOwned: WhileOwned) => Promise<Result<T, E>>,
): Promise<Result<T, E | ReceiptsFailure | PublicationInProgress>> {
  const token = randomUUID();
  const leaseFor = (): PublicationOwnership => ({
    token,
    expiresAt: clock.now() + OWNERSHIP_LEASE_MS,
  });
  const claimed = await receipts.update((state) =>
    claimPublication(state, key, leaseFor(), clock.now()),
  );
  if (claimed.isErr()) return Result.err(claimed.error);
  if (!ownsPublication(claimed.value, key, token))
    return Result.err(
      new PublicationInProgress({
        message: `Another job is publishing ${key}; run the command again once it finishes.`,
      }),
    );
  const whileOwned: WhileOwned = async (step) => {
    const renewed = await renewLease(receipts, key, leaseFor());
    return renewed.isErr() ? Result.err(renewed.error) : step();
  };
  let used: Result<T, E>;
  let released: Result<unknown, ReceiptsFailure>;
  try {
    used = await use(whileOwned);
  } finally {
    released = await receipts.update((state) => releasePublication(state, key, token));
  }
  return reportCleanup(
    used,
    released.map(() => undefined),
    logger,
  );
}

/** How long a publication owner holds its lease unrenewed; a crashed job's lease lapses after this. */
export const OWNERSHIP_LEASE_MS = 15 * 60 * 1000;

async function renewLease(
  receipts: PublicationReceipts,
  key: string,
  lease: PublicationOwnership,
): Promise<Result<void, ReceiptsFailure | PublicationInProgress>> {
  const renewed = await receipts.update((state) => renewPublication(state, key, lease));
  if (renewed.isErr()) return Result.err(renewed.error);
  if (ownsPublication(renewed.value, key, lease.token)) return Result.ok();
  return Result.err(
    new PublicationInProgress({
      message: `Another job took over publishing ${key} after this job's lease expired; this job stopped publishing.`,
    }),
  );
}
