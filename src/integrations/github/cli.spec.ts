import { describe, expect, it } from 'vitest';

import { buildJigCli } from './cli.js';

describe('buildJigCli', () => {
  it('composes core commands and the GitHub implementation command', () => {
    const program = buildJigCli();
    expect(program.commands.map((command) => command.name())).toContain('run');
    expect(
      program.commands
        .find((command) => command.name() === 'github')
        ?.commands.map((command) => command.name()),
    ).toEqual(['implement']);
  });
});
