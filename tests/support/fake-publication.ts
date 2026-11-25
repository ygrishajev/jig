import { faker } from '@faker-js/faker';
import { Result } from 'better-result';

import {
  claimPublication,
  emptyOrchestration,
  type Orchestration,
  orchestrationSchema,
  ownsPublication,
  publicationLease,
  releasePublication,
  renewPublication,
} from '../../src/domain/orchestration.js';
import type { RunId } from '../../src/domain/run-id.js';
import type {
  HeldPublication,
  PublicationOwnership,
  ReceiptStore,
  ReceiptStoreFailure,
} from '../../src/ports/publication-receipts.js';
import {
  type CodeCheckpoint,
  type InspectedRevision,
  type RunBranches,
  type RunBranchInspection,
  type RunBranchPublication,
  RunBranchUnpublishable,
} from '../../src/ports/run-branches.js';

/**
 * Receipts and leases shared by every job that is handed the same instance, kept as the real store
 * keeps them: saved as JSON and parsed back.
 */
export class InMemoryPublicationReceipts implements ReceiptStore, PublicationOwnership {
  private refusal?: {
    rejects: (next: Orchestration) => boolean;
    failure: ReceiptStoreFailure;
  };

  constructor(
    private readonly now: () => number = Date.now,
    private readonly shared = { state: emptyOrchestration() },
  ) {}

  get state(): Orchestration {
    return this.shared.state;
  }

  set state(state: Orchestration) {
    this.shared.state = state;
  }

  /** Another job on the same receipts, reading its own clock. */
  anotherJob(now = this.now): InMemoryPublicationReceipts {
    return new InMemoryPublicationReceipts(now, this.shared);
  }

  /** Fails, once, the first update whose outcome `rejects`, as a lost push would: nothing is saved. */
  failOnceSaving(rejects: (next: Orchestration) => boolean, failure: ReceiptStoreFailure): void {
    this.refusal = { rejects, failure };
  }

  async read() {
    return Result.ok(this.state);
  }

  async update(
    decide: (state: Orchestration) => Orchestration,
  ): Promise<Result<Orchestration, ReceiptStoreFailure>> {
    const next = decide(this.state);
    if (this.refusal?.rejects(next)) {
      const { failure } = this.refusal;
      this.refusal = undefined;
      return Result.err(failure);
    }
    this.state = orchestrationSchema.parse(JSON.parse(JSON.stringify(next)));
    return Result.ok(next);
  }

  async claim(key: string) {
    const token = faker.string.uuid();
    const now = this.now();
    const claimed = await this.update((state) =>
      claimPublication(state, key, publicationLease(token, now), now),
    );
    return claimed.map((state) =>
      ownsPublication(state, key, token) ? { key, token } : undefined,
    );
  }

  async renew({ key, token }: HeldPublication) {
    const renewed = await this.update((state) =>
      renewPublication(state, key, publicationLease(token, this.now())),
    );
    return renewed.map((state) => ownsPublication(state, key, token));
  }

  async release({ key, token }: HeldPublication) {
    const released = await this.update((state) => releasePublication(state, key, token));
    return released.map(() => undefined);
  }
}

/**
 * The run branches of one clone, told what git would find there. Like the real ones, it publishes
 * only the revision the branch holds and never one that changes a refused path.
 */
export class FakeRunBranches implements RunBranches {
  readonly heads = new Map<RunId, string>();
  readonly published = new Map<RunId, string>();
  readonly inspected: InspectedRevision[] = [];
  branch = 'main';
  refusedPaths: string[] = [];
  changesFiles = true;

  async checkedOutBranch() {
    return Result.ok(this.branch);
  }

  async head(runId: RunId) {
    return Result.ok(this.heads.get(runId));
  }

  async hasWorkBeyondStart({ startingCommit, codeRevision }: CodeCheckpoint) {
    return Result.ok(
      startingCommit !== undefined && codeRevision !== undefined && startingCommit !== codeRevision,
    );
  }

  async inspect(revision: InspectedRevision) {
    this.inspected.push(revision);
    return Result.ok<RunBranchInspection>(
      this.refusedPaths.length > 0
        ? { kind: 'refused', paths: this.refusedPaths }
        : { kind: 'clean', changesFiles: this.changesFiles },
    );
  }

  async publish({
    pushUnchanged = false,
    ...inspected
  }: InspectedRevision & { pushUnchanged?: boolean }): Promise<
    Result<RunBranchPublication, RunBranchUnpublishable>
  > {
    const { runId, revision } = inspected;
    if (this.heads.get(runId) !== revision)
      return Result.err(new RunBranchUnpublishable({ message: faker.lorem.sentence() }));
    const inspection = (await this.inspect(inspected)).value;
    if (inspection.kind === 'refused') return Result.ok(inspection);
    const { changesFiles } = inspection;
    if (!changesFiles && !pushUnchanged) return Result.ok({ kind: 'unchanged' });
    this.published.set(runId, revision);
    return Result.ok({ kind: 'published', changesFiles });
  }
}
