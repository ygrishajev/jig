import { faker } from '@faker-js/faker';
import { execa } from 'execa';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import type { JigOperations } from '../app/api.js';
import { buildCli, packageVersion } from '../cli/main.js';
import { buildJigCli } from './main.js';

describe('buildJigCli', () => {
  it('includes every core command alongside the GitHub command', () => {
    const coreCommandNames = buildCli(mock<JigOperations>()).commands.map((command) =>
      command.name(),
    );

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

  it('shows the GitHub command help outside a repository and without a token', async () => {
    const { runExecutable } = setup();

    const result = await runExecutable(['github', 'implement', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--issue');
  }, 30_000);

  it('builds the composed CLI on import without parsing the process arguments', async () => {
    const { importAndBuildInSubprocess } = setup();

    const { result, completionMarker } = await importAndBuildInSubprocess(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(completionMarker);
  }, 30_000);

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
      runExecutable: async (processArguments: string[]) =>
        execa(
          process.execPath,
          [
            '--import',
            createRequire(import.meta.url).resolve('tsx'),
            fileURLToPath(new URL('./main.ts', import.meta.url)),
            ...processArguments,
          ],
          {
            cwd: await tempDirectory(),
            env: { PATH: process.env.PATH },
            extendEnv: false,
            reject: false,
          },
        ),
      importAndBuildInSubprocess: async (processArguments: string[]) => {
        const completionMarker = faker.string.uuid();
        const importer = path.join(await tempDirectory(), 'import-composition.mjs');
        await writeFile(
          importer,
          [
            `import { buildJigCli } from ${JSON.stringify(new URL('./main.ts', import.meta.url).href)};`,
            'buildJigCli();',
            `process.stdout.write(${JSON.stringify(completionMarker)});`,
          ].join('\n'),
        );
        const result = await execa(
          process.execPath,
          ['--import', 'tsx', importer, ...processArguments],
          { reject: false },
        );
        return { result, completionMarker };
      },
    };
  }
});
