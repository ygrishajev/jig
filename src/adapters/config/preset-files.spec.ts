import { faker } from '@faker-js/faker';
import { readdirSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { presetName } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import {
  discoverPresets,
  loadPreset,
  type PresetLocations,
  presetNameSchema,
} from '../../config/presets.js';
import { ConfigInvalid } from '../../domain/errors.js';
import { packagedPresetsDirectory, presetFilesOnDisk } from './preset-files.js';

describe('presetFilesOnDisk', () => {
  describe('packagedPresetsDirectory', () => {
    it.each(['src', 'dist'])(
      "finds the package's presets from the module's place under %s",
      (outputDirectory) => {
        const moduleUrl = pathToFileURL(
          path.join(PACKAGE_ROOT, outputDirectory, 'adapters', 'config', 'preset-files.js'),
        ).href;

        expect(packagedPresetsDirectory(moduleUrl)).toBe(SHIPPED_PRESETS_DIRECTORY);
      },
    );

    it("reads the starters from the package's presets unless told otherwise", () => {
      const { repoRoot, homeDirectory } = someRoots();

      expect(presetFilesOnDisk().directories({ repoRoot, homeDirectory }).builtin).toBe(
        SHIPPED_PRESETS_DIRECTORY,
      );
    });
  });

  describe('directories', () => {
    it('keeps presets in the repository and home scratch directories, the XDG config home and the starters', () => {
      const roots = { ...someRoots(), xdgConfigHome: faker.system.directoryPath() };
      const builtinDirectory = faker.system.directoryPath();

      expect(presetFilesOnDisk(builtinDirectory).directories(roots)).toEqual({
        repository: path.join(roots.repoRoot, '.jig', 'presets'),
        home: path.join(roots.homeDirectory, '.jig', 'presets'),
        xdg: path.join(roots.xdgConfigHome, 'jig', 'presets'),
        builtin: builtinDirectory,
      });
    });

    it('uses ~/.config when there is no XDG config home', () => {
      const roots = someRoots();

      expect(presetFilesOnDisk().directories(roots).xdg).toBe(
        path.join(roots.homeDirectory, '.config', 'jig', 'presets'),
      );
    });

    it('gives the same path for the same directory however it was written', () => {
      const homeDirectory = faker.system.directoryPath();

      const directories = presetFilesOnDisk().directories({
        repoRoot: `${homeDirectory}${path.sep}.${path.sep}`,
        homeDirectory,
      });

      expect(directories.repository).toBe(directories.home);
    });
  });

  describe('filesIn', () => {
    it('lists each JSON file by the name its file gives it, valid or not', async () => {
      const { directory, write } = await setup();
      const names = [presetName(), presetName(), 'Not Safe'];
      for (const name of names) await write(`${name}.json`, '{}');
      await write(`${faker.word.noun()}.md`, faker.lorem.paragraph());

      const entries = unwrap(presetFilesOnDisk().filesIn(directory));

      expect(entries).toHaveLength(names.length);
      expect(entries).toEqual(
        expect.arrayContaining(
          names.map((name) => ({ name, path: path.join(directory, `${name}.json`) })),
        ),
      );
    });

    it('lists nothing where there is no directory', async () => {
      const { directory } = await setup();

      expect(unwrap(presetFilesOnDisk().filesIn(path.join(directory, 'absent')))).toEqual([]);
    });

    it('refuses a preset directory that is a file', async () => {
      const { write } = await setup();
      const notADirectory = await write('presets', '');

      const entries = presetFilesOnDisk().filesIn(notADirectory);

      expect(entries.isErr() && entries.error).toBeInstanceOf(ConfigInvalid);
      expect(entries.isErr() && entries.error.message).toContain(notADirectory);
    });

    it('refuses a preset directory under a path that is not a directory', async () => {
      const { write } = await setup();
      const underAFile = path.join(await write('.jig', ''), 'presets');

      const entries = presetFilesOnDisk().filesIn(underAFile);

      expect(entries.isErr() && entries.error).toBeInstanceOf(ConfigInvalid);
      expect(entries.isErr() && entries.error.message).toContain(underAFile);
    });

    it('refuses a preset directory that cannot be reached', async () => {
      const { directory } = await setup();
      const loop = path.join(directory, '.jig');
      await symlink('.jig', loop);

      const entries = presetFilesOnDisk().filesIn(path.join(loop, 'presets'));

      expect(entries.isErr() && entries.error).toBeInstanceOf(ConfigInvalid);
      expect(entries.isErr() && entries.error.message).toContain(path.join(loop, 'presets'));
    });
  });

  describe('isPresent', () => {
    it('finds a file that is there', async () => {
      const { write } = await setup();

      expect(unwrap(presetFilesOnDisk().isPresent(await write('found.json', '{}')))).toBe(true);
    });

    it('finds nothing where nothing is', async () => {
      const { directory } = await setup();

      expect(unwrap(presetFilesOnDisk().isPresent(path.join(directory, 'absent.json')))).toBe(
        false,
      );
    });

    it('counts a dangling link as present', async () => {
      const { linkDangling } = await setup();

      expect(unwrap(presetFilesOnDisk().isPresent(await linkDangling('dangling.json')))).toBe(true);
    });

    it('refuses rather than answers for a path under a file', async () => {
      const { write } = await setup();
      const underAFile = path.join(await write('.jig', ''), 'presets', 'shared.json');

      const present = presetFilesOnDisk().isPresent(underAFile);

      expect(present.isErr() && present.error).toBeInstanceOf(ConfigInvalid);
      expect(present.isErr() && present.error.message).toContain(underAFile);
    });
  });

  describe('fileFor', () => {
    it('names the JSON file of a preset in a directory', () => {
      const directory = faker.system.directoryPath();
      const name = presetName();

      expect(presetFilesOnDisk().fileFor(directory, name)).toBe(
        path.join(directory, `${name}.json`),
      );
    });
  });

  describe('read', () => {
    it('reads the JSON a file holds', async () => {
      const { write } = await setup();
      const contents = { planner: { provider: 'claude', model: faker.word.noun() } };

      const json = presetFilesOnDisk().read(await write('preset.json', JSON.stringify(contents)));

      expect(unwrap(json)).toEqual(contents);
    });

    it('refuses a file that is not JSON', async () => {
      const { write } = await setup();
      const file = await write('broken.json', '{ "planner": ');

      const json = presetFilesOnDisk().read(file);

      expect(json.isErr() && json.error).toBeInstanceOf(ConfigInvalid);
      expect(json.isErr() && json.error.message).toContain(file);
    });

    it('refuses a path it cannot read as a file', async () => {
      const { directory } = await setup();
      const folder = path.join(directory, 'folder.json');
      await mkdir(folder);

      const json = presetFilesOnDisk().read(folder);

      expect(json.isErr() && json.error).toBeInstanceOf(ConfigInvalid);
      expect(json.isErr() && json.error.message).toContain(folder);
    });

    it('refuses a dangling link', async () => {
      const { linkDangling } = await setup();
      const link = await linkDangling('dangling.json');

      const json = presetFilesOnDisk().read(link);

      expect(json.isErr() && json.error).toBeInstanceOf(ConfigInvalid);
      expect(json.isErr() && json.error.message).toContain(link);
    });
  });

  describe('with preset policy', () => {
    it('lists every shipped starter as builtin, each with a description and an agent for each step', async () => {
      const locations = await emptyLocations();

      const presets = unwrap(discoverPresets(presetFilesOnDisk(), locations));

      expect(presets.map(({ name, source, path }) => ({ name, source, path }))).toEqual(
        SHIPPED_STARTERS.map((name) => ({
          name,
          source: 'builtin',
          path: path.join(SHIPPED_PRESETS_DIRECTORY, `${name}.json`),
        })),
      );
      for (const preset of presets) {
        expect(preset.description).toEqual(expect.any(String));
        expect(Object.keys(preset.steps).sort()).toEqual([
          'describer',
          'implementer',
          'planner',
          'reviewer',
        ]);
      }
    });

    it('loads an operator preset over the starter of the same name', async () => {
      const locations = await emptyLocations();
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
      const model = faker.word.noun();
      const presets = path.join(locations.repoRoot, '.jig', 'presets');
      await mkdir(presets, { recursive: true });
      await writeFile(
        path.join(presets, `${starter}.json`),
        JSON.stringify({ reviewer: { provider: 'claude', model } }),
      );

      const preset = unwrap(loadPreset(presetFilesOnDisk(), locations, starter));

      expect(preset.source).toBe('repository');
      expect(preset.steps).toEqual({ reviewer: { provider: 'claude', model } });
    });

    it('refuses rather than falls back to the starter when the repository preset is a dangling link', async () => {
      const locations = await emptyLocations();
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
      const presets = path.join(locations.repoRoot, '.jig', 'presets');
      await mkdir(presets, { recursive: true });
      const winner = path.join(presets, `${starter}.json`);
      await symlink(path.join(presets, faker.string.uuid()), winner);

      const preset = loadPreset(presetFilesOnDisk(), locations, starter);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(winner);
    });
  });

  async function setup() {
    const directory = await tempDirectory('jig-preset-files-');
    const write = async (fileName: string, contents: string) => {
      const file = path.join(directory, fileName);
      await writeFile(file, contents);
      return file;
    };
    const linkDangling = async (fileName: string) => {
      const link = path.join(directory, fileName);
      await symlink(path.join(directory, faker.string.uuid()), link);
      return link;
    };
    return { directory, write, linkDangling };
  }
});

function someRoots() {
  return { repoRoot: faker.system.directoryPath(), homeDirectory: faker.system.directoryPath() };
}

async function emptyLocations(): Promise<PresetLocations> {
  return {
    repoRoot: await tempDirectory('jig-preset-repo-'),
    homeDirectory: await tempDirectory('jig-preset-home-'),
    xdgConfigHome: await tempDirectory('jig-preset-xdg-'),
  };
}

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Read from the repository's own `presets/`, not through the module, so the spec checks where the module looks. */
const SHIPPED_PRESETS_DIRECTORY = path.join(PACKAGE_ROOT, 'presets');

const SHIPPED_STARTERS = readdirSync(SHIPPED_PRESETS_DIRECTORY)
  .map((entry) => presetNameSchema.parse(path.basename(entry, '.json')))
  .sort();
