import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import { ConfigInvalid } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { type RunState, runStateSchema } from '../../domain/run-state.js';
import type { RunStore, RunStoreFailure } from '../../ports/run-store.js';
import { messageOf } from '../exception-details.js';
import { onLocalState } from './local-state.js';
import { makeRunDirectory, stateDirectory } from './run-paths.js';

/**
 * Keeps each run in `.jig/<runId>/state/run.json`. The file is replaced atomically, so a crash
 * mid-save leaves the previous checkpoint intact.
 */
export class LocalRunStore implements RunStore {
  constructor(private readonly repoRoot: string) {}

  async load(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    const file = path.join(stateDirectory(this.repoRoot, runId), STATE_FILE);
    if (!existsSync(file)) return Result.ok(undefined);
    const contents = await onLocalState(file, () => readFile(file, 'utf-8'));
    return contents.isErr() ? Result.err(contents.error) : parseRun(file, contents.value);
  }

  peek(runId: RunId): Promise<Result<RunState | undefined, RunStoreFailure>> {
    return this.load(runId);
  }

  async save(state: RunState): Promise<Result<void, RunStoreFailure>> {
    const directory = stateDirectory(this.repoRoot, state.runId);
    const file = path.join(directory, STATE_FILE);
    return onLocalState(file, async () => {
      await makeRunDirectory(this.repoRoot, state.runId);
      await mkdir(directory, { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    });
  }
}

const STATE_FILE = 'run.json';

function parseRun(file: string, contents: string): Result<RunState, ConfigInvalid> {
  return Result.try({
    try: () => runStateSchema.parse(JSON.parse(contents)),
    catch: (cause) =>
      new ConfigInvalid({ message: `The saved run in ${file} is not valid: ${messageOf(cause)}` }),
  });
}
