import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import type { RunId } from '../../domain/run-id.js';
import { type RunPhase, type RunState, stuckSlice } from '../../domain/run-state.js';
import { formatSummary, type MetricsSummary } from '../../observers/metrics.js';
import { makeRunDirectory, stateDirectory } from './run-paths.js';

export interface RunDocumentFile {
  name: RunDocument;
  path: string;
}

interface RunResult {
  runId: RunId;
  status: string;
  phase: RunPhase;
  complete: boolean;
  blockedReason: string | undefined;
  metrics: MetricsSummary;
}

/**
 * This machine's record of how an invocation of a run ended, written once at its end and only
 * here: `result.json` for CI, and the design, plan and pull request description as markdown for
 * a person. Each file is replaced atomically, so a reader never sees half of one.
 */
export class RunArtefacts {
  constructor(private readonly repoRoot: string) {}

  async write(state: RunState, status: string, metrics: MetricsSummary): Promise<void> {
    const directory = await this.makeStateDirectory(state.runId);
    const write = (name: string, contents: string | undefined): Promise<void> =>
      writeOrRemove(path.join(directory, name), contents);
    await write('result.json', `${JSON.stringify(resultFor(state, status, metrics), null, 2)}\n`);
    const contents = documentContents(state, metrics);
    for (const name of DOCUMENTS) await write(name, contents[name]);
  }

  private async makeStateDirectory(runId: RunId): Promise<string> {
    await makeRunDirectory(this.repoRoot, runId);
    const directory = stateDirectory(this.repoRoot, runId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  /** The documents this machine holds for the run; a run that has not produced one has no file. */
  documents(runId: RunId): RunDocumentFile[] {
    const directory = stateDirectory(this.repoRoot, runId);
    return DOCUMENTS.map((name) => ({ name, path: path.join(directory, name) })).filter(
      (document) => existsSync(document.path),
    );
  }
}

async function writeOrRemove(file: string, contents: string | undefined): Promise<void> {
  if (contents === undefined) await rm(file, { force: true });
  else await writeFileAtomic(file, contents);
}

/**
 * A small, stable summary for CI to read instead of parsing output that also carries whatever
 * an agent printed. `complete` and `blockedReason` keep the shape earlier workflows read.
 */
function resultFor(state: RunState, status: string, metrics: MetricsSummary): RunResult {
  return {
    runId: state.runId,
    status,
    phase: state.phase,
    complete: status === 'done',
    blockedReason: state.blockedReason ?? stuckSliceReason(state),
    metrics,
  };
}

function stuckSliceReason(state: RunState): string | undefined {
  const stuck = stuckSlice(state);
  return stuck ? `slice "${stuck.id}" is stuck — needs human intervention` : undefined;
}

function documentContents(
  state: RunState,
  metrics: MetricsSummary,
): Record<RunDocument, string | undefined> {
  return {
    'design.md': state.docs?.design,
    'plan.md': state.docs?.plan,
    'PR_DESCRIPTION.md': pullRequestDescription(state, metrics),
  };
}

function pullRequestDescription(state: RunState, metrics: MetricsSummary): string | undefined {
  if (state.prDescription === undefined) return undefined;
  const footer = `<sub>jig run ${state.runId}: ${formatSummary(metrics)}</sub>`;
  return `${state.prDescription}\n\n---\n${footer}\n`;
}

/** The markdown a run leaves for a person to read, in the order `jig status` lists them. */
const DOCUMENTS = ['design.md', 'plan.md', 'PR_DESCRIPTION.md'] as const;

export type RunDocument = (typeof DOCUMENTS)[number];
