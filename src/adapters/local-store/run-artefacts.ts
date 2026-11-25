import type { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import type { RunId } from '../../domain/run-id.js';
import type { LocalStateUnwritable } from '../../ports/local-state.js';
import {
  type InvocationRecord,
  type InvocationResult,
  RUN_DOCUMENTS,
  type RunDocumentFile,
} from '../../ports/run-records.js';
import { onLocalState } from './local-state.js';
import { makeRunDirectory, stateDirectory } from './run-paths.js';

/**
 * This machine's record of how an invocation of a run ended, written once at its end and only
 * here: `result.json` for CI, and the documents the invocation hands over as markdown for a
 * person. Each file is replaced atomically, so a reader never sees half of one.
 */
export class RunArtefacts {
  constructor(private readonly repoRoot: string) {}

  async write(invocation: InvocationRecord): Promise<Result<void, LocalStateUnwritable>> {
    const { runId } = invocation;
    const directory = stateDirectory(this.repoRoot, runId);
    return onLocalState(directory, async () => {
      await this.makeStateDirectory(runId);
      const write = (name: string, contents: string | undefined): Promise<void> =>
        writeOrRemove(path.join(directory, name), contents);
      await write('result.json', `${JSON.stringify(resultFile(invocation), null, 2)}\n`);
      for (const name of RUN_DOCUMENTS) await write(name, invocation.documents[name]);
    });
  }

  private async makeStateDirectory(runId: RunId): Promise<void> {
    await makeRunDirectory(this.repoRoot, runId);
    await mkdir(stateDirectory(this.repoRoot, runId), { recursive: true });
  }

  /** The documents this machine holds for the run; a run that has not produced one has no file. */
  documents(runId: RunId): RunDocumentFile[] {
    const directory = stateDirectory(this.repoRoot, runId);
    return RUN_DOCUMENTS.map((name) => ({ name, path: path.join(directory, name) })).filter(
      (document) => existsSync(document.path),
    );
  }
}

async function writeOrRemove(file: string, contents: string | undefined): Promise<void> {
  if (contents === undefined) await rm(file, { force: true });
  else await writeFileAtomic(file, contents);
}

/** The fields of `result.json`, in the order earlier workflows read them. */
function resultFile({ runId, result }: InvocationRecord): { runId: RunId } & InvocationResult {
  const { status, phase, complete, blockedReason, metrics } = result;
  return { runId, status, phase, complete, blockedReason, metrics };
}
