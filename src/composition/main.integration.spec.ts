import { faker } from '@faker-js/faker';
import { execa } from 'execa';
import { symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { packageVersion } from '../cli/main.js';

describe('jig executable', () => {
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

  it('runs when invoked through a symbolic link, as an installed executable is', async () => {
    const { runThroughSymlink } = setup();

    const result = await runThroughSymlink(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageVersion());
  }, 30_000);

  function setup() {
    return {
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
      runThroughSymlink: async (processArguments: string[]) => {
        const installed = path.join(await tempDirectory(), 'jig.ts');
        await symlink(fileURLToPath(new URL('./main.ts', import.meta.url)), installed);
        return execa(
          process.execPath,
          [
            '--import',
            createRequire(import.meta.url).resolve('tsx'),
            installed,
            ...processArguments,
          ],
          { reject: false },
        );
      },
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
