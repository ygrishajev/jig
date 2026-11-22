import { faker } from '@faker-js/faker';
import { execa } from 'execa';
import { readdirSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { aPreset } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { describePresets } from './presets.js';

describe('presets command', () => {
  it("lists the operator's presets over the starters they shadow, with where each is read from", async () => {
    const { listPresets, repoRoot } = await setup();
    const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
    const presets = path.join(repoRoot, '.jig', 'presets');
    await mkdir(presets, { recursive: true });
    await writeFile(path.join(presets, `${starter}.json`), '{}');

    const result = await listPresets();

    expect(result.exitCode).toBe(0);
    const listed = result.stdout
      .split('\n')
      .filter((line) => !line.startsWith(' '))
      .map((line) => line.split(/\s+/));
    expect(listed).toEqual([
      [starter, 'repository', path.join(presets, `${starter}.json`)],
      ...SHIPPED_STARTERS.filter((name) => name !== starter).map((name) => [
        name,
        'builtin',
        path.join(SHIPPED_PRESETS_DIRECTORY, `${name}.json`),
      ]),
    ]);
  }, 30_000);

  async function setup() {
    const repo = await createTempRepo();
    const home = await tempDirectory('jig-presets-home-');
    const coreBuilder = new URL('../main.ts', import.meta.url).href;
    const script = [
      `process.chdir(${JSON.stringify(repo.dir)});`,
      `import { buildCli } from ${JSON.stringify(coreBuilder)};`,
      `await buildCli().parseAsync(['presets'], { from: 'user' });`,
    ].join('\n');
    const listPresets = () =>
      execa(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') },
        extendEnv: false,
        reject: false,
      });
    return { listPresets, repoRoot: await realpath(repo.dir) };
  }
});

describe('describePresets', () => {
  it('lists each preset with where it was read from, and its description when it has one', () => {
    const described = aPreset({ description: faker.lorem.sentence() });
    const bare = aPreset();

    const lines = describePresets([described, bare]).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^${described.name}\\s+${described.label.source}\\s+`));
    expect(lines[0]?.endsWith(described.label.location)).toBe(true);
    expect(lines[1]?.trim()).toBe(described.description);
    expect(lines[2]).toMatch(new RegExp(`^${bare.name}\\s+${bare.label.source}\\s+`));
    expect(lines[2]?.endsWith(bare.label.location)).toBe(true);
  });

  it('says there are none rather than printing nothing', () => {
    expect(describePresets([])).not.toBe('');
  });
});

/** Read from the repository's own `presets/`, not through the module, so the spec checks where the command looks. */
const SHIPPED_PRESETS_DIRECTORY = fileURLToPath(new URL('../../../presets', import.meta.url));

const SHIPPED_STARTERS = readdirSync(SHIPPED_PRESETS_DIRECTORY)
  .map((entry) => path.basename(entry, '.json'))
  .sort();
