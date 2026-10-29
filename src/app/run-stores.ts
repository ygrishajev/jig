import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { CompositeRunStore } from '../adapters/run-store/composite-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { ConfigInvalid } from '../domain/errors.js';
import type { RunId } from '../domain/run-id.js';
import { runStateSchema, type RunState } from '../domain/run-state.js';
import type { RunStore } from '../ports/run-store.js';
import type { AppCradle } from './container.js';

/**
 * What a custom store module default-exports: `runStores: ["./my-store.js"]` in the config. The
 * store needs `load` and `save`; `peek` is optional, and `load` stands in for it when absent.
 */
export type RunStoreFactory = (context: { repoRoot: string }) => unknown;

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
  const imported: { default?: unknown } = await import(
    pathToFileURL(path.resolve(repoRoot, name)).href
  );
  const factory = imported.default;
  if (typeof factory !== 'function') {
    throw new ConfigInvalid(
      `Run store "${name}" must default-export a function that returns a store.`,
    );
  }
  const store: unknown = await factory({ repoRoot });
  if (!isModuleStore(store)) {
    throw new ConfigInvalid(
      `Run store "${name}" must return an object with load and save methods.`,
    );
  }
  return new ModuleRunStore(name, store);
}

/** A store from a module: its methods are known to exist, what they return is not trusted. */
interface ModuleStore {
  load(runId: RunId): unknown;
  save(state: RunState): unknown;
  peek?(runId: RunId): unknown;
}

const moduleStoreShape = z.object({
  load: z.function(),
  save: z.function(),
  peek: z.function().optional(),
});

/** Checks the shape only; the store itself is kept, so its methods still see their own `this`. */
function isModuleStore(value: unknown): value is ModuleStore {
  return moduleStoreShape.safeParse(value).success;
}

/** Parses what a module store hands back, so a malformed run fails where it came in. */
class ModuleRunStore implements RunStore {
  constructor(
    private readonly name: string,
    private readonly store: ModuleStore,
  ) {}

  async load(runId: RunId) {
    return this.parsed(await this.store.load(runId));
  }

  async peek(runId: RunId) {
    return this.parsed(await (this.store.peek ? this.store.peek(runId) : this.store.load(runId)));
  }

  async save(state: RunState) {
    await this.store.save(state);
  }

  private parsed(loaded: unknown) {
    if (loaded === undefined || loaded === null) return undefined;
    const parsed = runStateSchema.safeParse(loaded);
    if (!parsed.success) {
      throw new ConfigInvalid(
        `Run store "${this.name}" returned a malformed run: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }
}
