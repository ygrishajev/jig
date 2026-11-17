import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { isWorkingTreeClean } from '../git/repository.js';
import {
  agentLogFile,
  JIG_DIR,
  makeRunDirectory,
  runLogFile,
  stateDirectory,
} from './run-paths.js';

describe('makeRunDirectory', () => {
  it("keeps everything it puts under .jig out of the target repository's status", async () => {
    const { dir } = await createTempRepo();
    const git = simpleGit({ baseDir: dir });
    await writeFile(path.join(dir, '.gitignore'), '');
    await git.add('.gitignore').commit(faker.git.commitMessage());

    const directory = await makeRunDirectory(dir, runId());
    await writeFile(path.join(directory, `${faker.word.noun()}.json`), '{}');

    expect((await isWorkingTreeClean(dir)).unwrap()).toBe(true);
  });

  it('leaves a .jig/.gitignore the operator already has alone', async () => {
    const { dir } = await createTempRepo();
    const first = await makeRunDirectory(dir, runId());
    const gitignore = path.join(dir, JIG_DIR, '.gitignore');
    const own = `${faker.word.noun()}\n`;
    await writeFile(gitignore, own);

    await makeRunDirectory(dir, runId());

    expect(first.startsWith(path.join(dir, JIG_DIR))).toBe(true);
    expect(await readFile(gitignore, 'utf-8')).toBe(own);
  });
});

describe('run log files', () => {
  it("keeps jig's log and the agents' log apart, both in the run's state directory", () => {
    const repoRoot = faker.system.directoryPath();
    const id = runId();
    const directory = stateDirectory(repoRoot, id);

    expect(path.dirname(runLogFile(repoRoot, id))).toBe(directory);
    expect(path.dirname(agentLogFile(repoRoot, id))).toBe(directory);
    expect(runLogFile(repoRoot, id)).not.toBe(agentLogFile(repoRoot, id));
  });
});
