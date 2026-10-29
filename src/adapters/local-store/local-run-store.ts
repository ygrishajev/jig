import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { RunId } from '../../domain/run-id.js';
import type { RunState } from '../../domain/run-state.js';
import type { RunStore } from '../../ports/run-store.js';
import { makeRunDirectory, stateDirectory } from './run-paths.js';
import { runStateSchema } from './run-state-schema.js';

const STATE_FILE = 'run.json';

/**
 * Keeps each run in `.sdlc/<runId>/state/run.json`. The file is replaced atomically, so a crash
 * mid-save leaves the previous checkpoint intact.
 */
export class LocalRunStore implements RunStore {
  constructor(private readonly repoRoot: string) {}

  async load(runId: RunId) {
    const file = path.join(stateDirectory(this.repoRoot, runId), STATE_FILE);
    if (!existsSync(file)) return undefined;
    return runStateSchema.parse(JSON.parse(await readFile(file, 'utf-8')));
  }

  peek(runId: RunId) {
    return this.load(runId);
  }

  async save(state: RunState) {
    await makeRunDirectory(this.repoRoot, state.runId);
    const directory = stateDirectory(this.repoRoot, state.runId);
    await mkdir(directory, { recursive: true });
    await writeFileAtomic(path.join(directory, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  }
}
