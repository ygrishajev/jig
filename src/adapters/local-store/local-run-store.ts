import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { RunState } from '../../domain/run-state.js';
import { formatSummary, type MetricsSummary } from '../../observers/metrics.js';
import type { RunStore } from '../../ports/run-store.js';
import { SDLC_DIR, stateDirectory } from './run-paths.js';
import { runStateSchema } from './run-state-schema.js';

const STATE_FILE = 'run.json';
const RESULT_FILE = 'result.json';

/**
 * Keeps each run in `.sdlc/<runId>/state/run.json`, with the documents a person reads —
 * design, plan, pull request description — written beside it as markdown. The state file is
 * replaced atomically, so a crash mid-save leaves the previous checkpoint intact.
 */
export class LocalRunStore implements RunStore {
  constructor(private readonly repoRoot: string) {}

  async load(runId: string) {
    const file = path.join(stateDirectory(this.repoRoot, runId), STATE_FILE);
    if (!existsSync(file)) return undefined;
    return runStateSchema.parse(JSON.parse(await readFile(file, 'utf-8')));
  }

  async save(state: RunState) {
    const directory = stateDirectory(this.repoRoot, state.runId);
    await mkdir(directory, { recursive: true });
    await this.ignoreSdlcDirectory();
    await writeFileAtomic(path.join(directory, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
    await writeOrRemove(path.join(directory, 'design.md'), state.docs?.design);
    await writeOrRemove(path.join(directory, 'plan.md'), state.docs?.plan);
    await writeOrRemove(path.join(directory, 'PR_DESCRIPTION.md'), state.prDescription);
  }

  /**
   * A small, stable summary for CI to read instead of parsing output that also carries whatever
   * an agent printed. `complete` and `blockedReason` keep the shape earlier workflows read.
   */
  async writeResult(state: RunState, status: string, metrics?: MetricsSummary) {
    const result = {
      runId: state.runId,
      status,
      phase: state.phase,
      complete: status === 'done',
      blockedReason: state.blockedReason ?? stuckSliceReason(state),
      ...(metrics ? { metrics } : {}),
    };
    const directory = stateDirectory(this.repoRoot, state.runId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
    if (state.prDescription && metrics) {
      const footer = `\n\n---\n<sub>sdlc run ${state.runId}: ${formatSummary(metrics)}</sub>\n`;
      await writeFile(path.join(directory, 'PR_DESCRIPTION.md'), `${state.prDescription}${footer}`);
    }
  }

  documentPath(runId: string, name: 'design.md' | 'plan.md' | 'PR_DESCRIPTION.md') {
    const file = path.join(stateDirectory(this.repoRoot, runId), name);
    return existsSync(file) ? file : undefined;
  }

  /** The target repository has no reason to know about `.sdlc/`, and an untracked one would block the final merge. */
  private async ignoreSdlcDirectory() {
    const gitignore = path.join(this.repoRoot, SDLC_DIR, '.gitignore');
    if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');
  }
}

async function writeOrRemove(file: string, contents: string | undefined) {
  if (contents === undefined) await rm(file, { force: true });
  else await writeFile(file, contents);
}

function stuckSliceReason(state: RunState) {
  const stuck = state.slices.find((slice) => slice.status === 'stuck');
  return stuck ? `slice "${stuck.id}" is stuck — needs human intervention` : undefined;
}
