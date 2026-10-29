import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CompositeRunStore } from '../adapters/run-store/composite-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { ConfigInvalid } from '../domain/errors.js';
import type { RunStore } from '../ports/run-store.js';

/** What a custom store module default-exports: `runStores: ["./my-store.js"]` in the config. */
export type RunStoreFactory = (context: { repoRoot: string }) => RunStore | Promise<RunStore>;

/**
 * The stores a run is saved to, from `runStores` in the config: `local`, `git-remote`, or a path
 * to a module. Saved to all of them; loaded from the first that has the run.
 */
export async function createRunStore(input: {
  repoRoot: string;
  names: string[];
  local: RunStore;
}): Promise<RunStore> {
  const stores = await Promise.all(input.names.map((name) => storeNamed(name, input)));
  return stores.length === 1 ? stores[0] : new CompositeRunStore(stores);
}

async function storeNamed(name: string, input: { repoRoot: string; local: RunStore }) {
  if (name === 'local') return input.local;
  if (name === 'git-remote') return new GitRemoteRunStore(input.repoRoot);
  const modulePath = path.resolve(input.repoRoot, name);
  const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  if (typeof loaded.default !== 'function') {
    throw new ConfigInvalid(
      `Run store "${name}" must default-export a function that returns a store with load and save.`,
    );
  }
  return (loaded.default as RunStoreFactory)({ repoRoot: input.repoRoot });
}
