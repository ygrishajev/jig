import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { RunState } from '../../domain/run-state.js';
import { formatSummary, type MetricsSummary } from '../../observers/metrics.js';
import { makeRunDirectory, stateDirectory } from './run-paths.js';

export type RunDocument = 'design.md' | 'plan.md' | 'PR_DESCRIPTION.md';

/**
 * This machine's record of how an invocation of a run ended, written once at its end and only
 * here: `result.json` for CI, and the design, plan and pull request description as markdown for
 * a person. Each file is replaced atomically, so a reader never sees half of one.
 */
export class RunArtefacts {
  constructor(private readonly repoRoot: string) {}

  async write(state: RunState, status: string, metrics: MetricsSummary) {
    const directory = await this.makeStateDirectory(state.runId);
    const write = (name: string, contents: string | undefined) =>
      writeOrRemove(path.join(directory, name), contents);
    await write('result.json', `${JSON.stringify(resultFor(state, status, metrics), null, 2)}\n`);
    await write('design.md', state.docs?.design);
    await write('plan.md', state.docs?.plan);
    await write('PR_DESCRIPTION.md', pullRequestDescription(state, metrics));
  }

  documentPath(runId: string, name: RunDocument) {
    const file = path.join(stateDirectory(this.repoRoot, runId), name);
    return existsSync(file) ? file : undefined;
  }

  private async makeStateDirectory(runId: string) {
    await makeRunDirectory(this.repoRoot, runId);
    const directory = stateDirectory(this.repoRoot, runId);
    await mkdir(directory, { recursive: true });
    return directory;
  }
}

/**
 * A small, stable summary for CI to read instead of parsing output that also carries whatever
 * an agent printed. `complete` and `blockedReason` keep the shape earlier workflows read.
 */
function resultFor(state: RunState, status: string, metrics: MetricsSummary) {
  return {
    runId: state.runId,
    status,
    phase: state.phase,
    complete: status === 'done',
    blockedReason: state.blockedReason ?? stuckSliceReason(state),
    metrics,
  };
}

function pullRequestDescription(state: RunState, metrics: MetricsSummary) {
  if (state.prDescription === undefined) return undefined;
  const footer = `<sub>sdlc run ${state.runId}: ${formatSummary(metrics)}</sub>`;
  return `${state.prDescription}\n\n---\n${footer}\n`;
}

async function writeOrRemove(file: string, contents: string | undefined) {
  if (contents === undefined) await rm(file, { force: true });
  else await writeFileAtomic(file, contents);
}

function stuckSliceReason(state: RunState) {
  const stuck = state.slices.find((slice) => slice.status === 'stuck');
  return stuck ? `slice "${stuck.id}" is stuck — needs human intervention` : undefined;
}
