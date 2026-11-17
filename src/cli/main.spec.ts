import { describe, expect, it } from 'vitest';

import { buildCli, packageVersion } from './main.js';

describe('buildCli', () => {
  it('composes the core commands without GitHub configuration', () => {
    const program = buildCli();
    expect(program.commands.map((command) => command.name())).toContain('run');
    expect(program.commands.map((command) => command.name())).not.toContain('github');
    expect(program.version()).toBe(packageVersion());
  });
});
