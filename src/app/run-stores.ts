import { Result, TaggedError } from 'better-result';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { GitRunCode } from '../adapters/git/run-code.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { CompositeRunStore } from '../adapters/run-store/composite-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import type { RunId } from '../domain/run-id.js';
import { type RunState, runStateSchema } from '../domain/run-state.js';
import { messageOf } from '../failures/messages.js';
import { RunStateInvalid } from '../ports/run-state-failures.js';
import { type RunStore, RunStoreOperationFailed } from '../ports/run-store.js';
import type { AppCradle } from './container.js';

/**
 * What a custom store module default-exports: `runStores: ["./my-store.js"]` in the config. The
 * store needs `load` and `save`; `peek` is optional, and `load` stands in for it when absent.
 */
export type RunStoreFactory = (context: { repoRoot: string }) => unknown;

/** A store from a module: its methods are known to exist, what they return is not trusted. */
interface ModuleStore {
  load(runId: RunId): unknown;
  save(state: RunState): unknown;
  peek?(runId: RunId): unknown;
}

type ModuleStoreFailure = RunStoreOperationFailed | RunStateInvalid;

/**
 * The one place that decides where a run's state is read from and written to: every store named
 * in `runStores` — `local`, `git-remote`, or a path to a module — holding a copy, the freshest
 * copy winning on load. Every reader and writer of run state goes through it. What else sits in
 * `.jig/<id>/state/` — `result.json`, `metrics.jsonl`, the logs and the markdown documents — is
 * this machine's record of the invocations it ran, not part of the run, and stays local.
 */
export async function openRunStore(
  { repoRoot, config }: Pick<AppCradle, 'repoRoot' | 'config'>,
  requiredStores: string[] = [],
): Promise<Result<RunStore, RunStoreSetupInvalid>> {
  const stores: RunStore[] = [];
  for (const name of new Set([...config.runStores, ...requiredStores])) {
    const store = await storeNamed(name, repoRoot);
    if (store.isErr()) return Result.err(store.error);
    stores.push(store.value);
  }
  return Result.ok(new CompositeRunStore(stores, new GitRunCode(repoRoot)));
}

async function storeNamed(
  name: string,
  repoRoot: string,
): Promise<Result<RunStore, RunStoreSetupInvalid>> {
  if (name === 'local') return Result.ok(new LocalRunStore(repoRoot));
  if (name === 'git-remote') return Result.ok(new GitRemoteRunStore(repoRoot));
  const imported = await Result.tryPromise({
    try: (): Promise<{ default?: unknown }> =>
      import(pathToFileURL(path.resolve(repoRoot, name)).href),
    catch: (cause) => new RunStoreSetupInvalid({ message: moduleFailureMessage(name, cause) }),
  });
  if (imported.isErr()) return Result.err(imported.error);
  const factory = imported.value.default;
  if (typeof factory !== 'function') {
    return Result.err(
      new RunStoreSetupInvalid({
        message: `Run store "${name}" must default-export a function that returns a store.`,
      }),
    );
  }
  const store = await Result.tryPromise({
    try: async (): Promise<unknown> => factory({ repoRoot }),
    catch: (cause) => new RunStoreSetupInvalid({ message: moduleFailureMessage(name, cause) }),
  });
  if (store.isErr()) return Result.err(store.error);
  if (!isModuleStore(store.value)) {
    return Result.err(
      new RunStoreSetupInvalid({
        message: `Run store "${name}" must return an object with load and save methods.`,
      }),
    );
  }
  return Result.ok(new ModuleRunStore(name, store.value));
}

/** A store named in `runStores` cannot be used: its module would not load, or is not a store. */
export class RunStoreSetupInvalid extends TaggedError('RunStoreSetupInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** A custom store is the operator's code: when it throws, the operator's config is what to fix. */
function moduleFailureMessage(name: string, cause: unknown): string {
  return `Run store "${name}" failed: ${messageOf(cause)}`;
}

/** Checks the shape only; the store itself is kept, so its methods still see their own `this`. */
function isModuleStore(value: unknown): value is ModuleStore {
  return moduleStoreShape.safeParse(value).success;
}

const moduleStoreShape = z.object({
  load: z.function(),
  save: z.function(),
  peek: z.function().optional(),
});

/** Parses what a module store hands back, so a malformed run fails where it came in. */
class ModuleRunStore implements RunStore {
  constructor(
    private readonly name: string,
    private readonly store: ModuleStore,
  ) {}

  async load(runId: RunId): Promise<Result<RunState | undefined, ModuleStoreFailure>> {
    return this.parsed(await this.call(() => this.store.load(runId)));
  }

  private parsed(
    loaded: Result<unknown, RunStoreOperationFailed>,
  ): Result<RunState | undefined, ModuleStoreFailure> {
    if (loaded.isErr()) return Result.err(loaded.error);
    if (loaded.value === undefined || loaded.value === null) return Result.ok(undefined);
    const parsed = runStateSchema.safeParse(loaded.value);
    if (parsed.success) return Result.ok(parsed.data);
    return Result.err(
      new RunStateInvalid({
        message: `Run store "${this.name}" returned a malformed run: ${parsed.error.message}`,
      }),
    );
  }

  private call(operation: () => unknown): Promise<Result<unknown, RunStoreOperationFailed>> {
    return Result.tryPromise({
      try: async () => operation(),
      catch: (cause) =>
        new RunStoreOperationFailed({ message: moduleFailureMessage(this.name, cause) }),
    });
  }

  async peek(runId: RunId): Promise<Result<RunState | undefined, ModuleStoreFailure>> {
    const peeked = await this.call(() =>
      this.store.peek ? this.store.peek(runId) : this.store.load(runId),
    );
    return this.parsed(peeked);
  }

  async save(state: RunState): Promise<Result<void, RunStoreOperationFailed>> {
    const saved = await this.call(() => this.store.save(state));
    return saved.map(() => undefined);
  }
}
