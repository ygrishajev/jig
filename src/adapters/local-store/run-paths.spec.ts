import { faker } from '@faker-js/faker';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { agentLogFile, runLogFile, stateDirectory } from './run-paths.js';

describe('run log files', () => {
  it("keeps jig's log and the agents' log apart, both in the run's state directory", () => {
    const repoRoot = faker.system.directoryPath();
    const id = runId();
    const directory = stateDirectory(repoRoot, id);

    expect(directory).toBe(path.join(repoRoot, '.jig', id, 'state'));
    expect(path.dirname(runLogFile(repoRoot, id))).toBe(directory);
    expect(path.dirname(agentLogFile(repoRoot, id))).toBe(directory);
    expect(runLogFile(repoRoot, id)).not.toBe(agentLogFile(repoRoot, id));
  });
});
