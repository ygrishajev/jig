import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import type { JigOperations } from '../app/api.js';
import type { RunCommandIo } from './commands/run.js';
import { buildCli, packageVersion } from './main.js';

describe('buildCli', () => {
  it('composes the core commands without the GitHub command and reports the package version', () => {
    const program = buildCli(mock<JigOperations>(), mock<RunCommandIo>());
    expect(program.commands.map((command) => command.name())).toContain('run');
    expect(program.commands.map((command) => command.name())).not.toContain('github');
    expect(program.version()).toBe(packageVersion());
  });
});
