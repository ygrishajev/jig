import { Result } from 'better-result';

import type { JigConfig } from '../config/load-config.js';
import type { RunStore, RunStoreCatalog, RunStoreSetupInvalid } from '../ports/run-store.js';

/**
 * The one place that decides where a run's state is read from and written to: every store named
 * in `runStores` and every store the operation requires, each once, holding a copy, the freshest
 * copy winning on load. Every reader and writer of run state goes through it. What else sits in
 * `.jig/<id>/state/` — `result.json`, `metrics.jsonl`, the logs and the markdown documents — is
 * this machine's record of the invocations it ran, not part of the run, and stays local.
 */
export async function openRunStore(
  catalog: RunStoreCatalog,
  config: Pick<JigConfig, 'runStores'>,
  requiredStores: readonly string[] = [],
): Promise<Result<RunStore, RunStoreSetupInvalid>> {
  const stores: RunStore[] = [];
  for (const name of new Set([...config.runStores, ...requiredStores])) {
    const store = await catalog.storeNamed(name);
    if (store.isErr()) return Result.err(store.error);
    stores.push(store.value);
  }
  return Result.ok(catalog.combined(stores));
}
