import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { CompositeRunStore } from '../adapters/run-store/composite-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { ConfigInvalid } from '../domain/errors.js';
import type { RunStore } from '../ports/run-store.js';
import type { AppCradle } from './container.js';

/** What a custom store module default-exports: `runStores: ["./my-store.js"]` in the config. */
export type RunStoreFactory = (context: { repoRoot: string }) => RunStore | Promise<RunStore>;

/**
 * The one place that decides where a run's state is read from and written to: every store named
 * in `runStores` — `local`, `git-remote`, or a path to a module — holding a copy, the freshest
 * copy winning on load. Every reader and writer of run state goes through it. What else sits in
 * `.sdlc/<id>/state/` — `result.json`, `metrics.jsonl`, the logs and the markdown documents — is
 * this machine's record of the invocations it ran, not part of the run, and stays local.
 */
export async function openRunStore({
  repoRoot,
  config,
}: Pick<AppCradle, 'repoRoot' | 'config'>): Promise<RunStore> {
  const stores = await Promise.all(config.runStores.map((name) => storeNamed(name, repoRoot)));
  return new CompositeRunStore(stores);
}

async function storeNamed(name: string, repoRoot: string): Promise<RunStore> {
  if (name === 'local') return new LocalRunStore(repoRoot);
  if (name === 'git-remote') return new GitRemoteRunStore(repoRoot);
  const modulePath = path.resolve(repoRoot, name);
  const loaded = (await import(pathToFileURL(modulePath).href)) as { default?: unknown };
  if (typeof loaded.default !== 'function') {
    throw new ConfigInvalid(
      `Run store "${name}" must default-export a function that returns a store with load and save.`,
    );
  }
  return (loaded.default as RunStoreFactory)({ repoRoot });
}
