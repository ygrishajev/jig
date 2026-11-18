import { describe, expect, it } from 'vitest';

import { buildCli, packageVersion } from '../../cli/main.js';
import { buildJigCli } from './cli.js';

describe('buildJigCli', () => {
  it('includes every core command alongside the GitHub command', () => {
    const coreCommandNames = buildCli().commands.map((command) => command.name());

    const composedCommandNames = buildJigCli().commands.map((command) => command.name());

    expect(composedCommandNames).toEqual(expect.arrayContaining(coreCommandNames));
    expect(composedCommandNames).toContain('github');
  });

  it('nests the implementation command under the GitHub command', () => {
    const github = buildJigCli().commands.find((command) => command.name() === 'github');

    expect(github?.commands.map((command) => command.name())).toEqual(['implement']);
  });

  it('prints the package version and terminates successfully', () => {
    const { parse, printed } = setup();

    expect(() => parse(['--version'])).toThrow(
      expect.objectContaining({ code: 'commander.version', exitCode: 0 }),
    );
    expect(printed().trim()).toBe(packageVersion());
  });

  function setup() {
    let output = '';
    const program = buildJigCli()
      .exitOverride()
      .configureOutput({
        writeOut: (text) => {
          output += text;
        },
      });
    return {
      parse: (args: string[]) => program.parse(args, { from: 'user' }),
      printed: () => output,
    };
  }
});
