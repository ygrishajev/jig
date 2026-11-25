import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  anInvocationRecord,
  anInvocationResult,
  aRunState,
  runId,
  someRunDocuments,
} from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import type { RunId } from '../../domain/run-id.js';
import { LocalRunStore } from './local-run-store.js';
import { RunArtefacts } from './run-artefacts.js';
import { stateDirectory } from './run-paths.js';

describe('RunArtefacts', () => {
  it('writes each document it is handed, listed in order', async () => {
    const { artefacts, read, repoRoot } = await setup();
    const invocation = anInvocationRecord();
    const { documents } = invocation;

    (await artefacts.write(invocation)).unwrap();

    const id = invocation.runId;
    const names = ['design.md', 'plan.md', 'design-review.md', 'PR_DESCRIPTION.md'] as const;
    for (const name of names) expect(await read(id, name)).toBe(documents[name]);
    const directory = stateDirectory(repoRoot, id);
    expect(artefacts.documents(id)).toEqual(
      names.map((name) => ({ name, path: path.join(directory, name) })),
    );
  });

  it('replaces a document written by an earlier invocation', async () => {
    const { artefacts, read } = await setup();
    const id = runId();
    (await artefacts.write(anInvocationRecord({ runId: id }))).unwrap();
    const replaced = someRunDocuments();

    (await artefacts.write(anInvocationRecord({ runId: id, documents: replaced }))).unwrap();

    expect(await read(id, 'plan.md')).toBe(replaced['plan.md']);
  });

  it('keeps the pull request description when the run is saved again afterwards', async () => {
    const { artefacts, read, repoRoot } = await setup();
    const invocation = anInvocationRecord();
    (await artefacts.write(invocation)).unwrap();

    (
      await new LocalRunStore(repoRoot).save(aRunState({ runId: invocation.runId, phase: 'done' }))
    ).unwrap();

    expect(await read(invocation.runId, 'PR_DESCRIPTION.md')).toBe(
      invocation.documents['PR_DESCRIPTION.md'],
    );
  });

  it('removes a document the invocation no longer has', async () => {
    const { artefacts, repoRoot } = await setup();
    const id = runId();
    (await artefacts.write(anInvocationRecord({ runId: id }))).unwrap();

    const absent = {
      'design.md': undefined,
      'plan.md': undefined,
      'design-review.md': undefined,
      'PR_DESCRIPTION.md': undefined,
    };
    (await artefacts.write(anInvocationRecord({ runId: id, documents: absent }))).unwrap();

    const directory = stateDirectory(repoRoot, id);
    for (const name of Object.keys(absent)) {
      expect(existsSync(path.join(directory, name))).toBe(false);
    }
    expect(artefacts.documents(id)).toEqual([]);
  });

  it('saves how the invocation ended for CI, with its run id first', async () => {
    const { artefacts, read } = await setup();
    const invocation = anInvocationRecord({
      result: anInvocationResult({ blockedReason: faker.lorem.sentence() }),
    });

    (await artefacts.write(invocation)).unwrap();

    const saved = await read(invocation.runId, 'result.json');
    expect(JSON.parse(saved)).toStrictEqual({ runId: invocation.runId, ...invocation.result });
    expect(Object.keys(JSON.parse(saved))).toEqual([
      'runId',
      'status',
      'phase',
      'complete',
      'blockedReason',
      'metrics',
    ]);
  });

  it('leaves out a result without a blocked reason', async () => {
    const { artefacts, read } = await setup();
    const invocation = anInvocationRecord({
      result: { ...anInvocationResult(), blockedReason: undefined },
    });

    (await artefacts.write(invocation)).unwrap();

    expect(JSON.parse(await read(invocation.runId, 'result.json'))).not.toHaveProperty(
      'blockedReason',
    );
  });

  it('keeps its own directory out of the operator repository', async () => {
    const { artefacts, repoRoot } = await setup();

    (await artefacts.write(anInvocationRecord())).unwrap();

    expect(await readFile(path.join(repoRoot, '.jig', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-artefacts-');
    const read = (id: RunId, name: string) =>
      readFile(path.join(stateDirectory(repoRoot, id), name), 'utf-8');
    return { artefacts: new RunArtefacts(repoRoot), read, repoRoot };
  }
});
