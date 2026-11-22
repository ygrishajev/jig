import { faker } from '@faker-js/faker';
import { panic } from 'better-result';
import { readdirSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { presetName } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import {
  PresetNotFindable,
  PresetNotJson,
  type PresetSource,
  PresetsUnlistable,
  PresetUnreadable,
} from '../../config/preset-source.js';
import {
  discoverPresets,
  loadPreset,
  type PresetName,
  presetNameSchema,
} from '../../config/presets.js';
import { ConfigInvalid } from '../../domain/errors.js';
import {
  packagedPresetsDirectory,
  presetDirectoriesSource,
  type PresetLocations,
} from './preset-source.js';

describe('presetDirectoriesSource', () => {
  describe('packagedPresetsDirectory', () => {
    it.each(['src', 'dist'])(
      "finds the package's presets from the module's place under %s",
      (outputDirectory) => {
        const moduleUrl = pathToFileURL(
          path.join(PACKAGE_ROOT, outputDirectory, 'adapters', 'filesystem', 'preset-source.js'),
        ).href;

        expect(packagedPresetsDirectory(moduleUrl)).toBe(SHIPPED_PRESETS_DIRECTORY);
      },
    );

    it("looks in the package's presets last unless told otherwise", () => {
      const source = presetDirectoriesSource(someLocations());

      expect(source.places.at(-1)).toBe(SHIPPED_PRESETS_DIRECTORY);
    });
  });

  describe('places', () => {
    it('looks in the repository and home scratch directories, the XDG config home, then the starters', () => {
      const locations = { ...someLocations(), xdgConfigHome: faker.system.directoryPath() };
      const starterDirectory = faker.system.directoryPath();

      expect(presetDirectoriesSource(locations, starterDirectory).places).toEqual([
        path.join(locations.repoRoot, '.jig', 'presets'),
        path.join(locations.homeDirectory, '.jig', 'presets'),
        path.join(locations.xdgConfigHome, 'jig', 'presets'),
        starterDirectory,
      ]);
    });

    it.each([undefined, '', path.join(faker.word.noun(), faker.word.noun())])(
      'uses ~/.config when the XDG config home is %j',
      (xdgConfigHome) => {
        const locations = { ...someLocations(), xdgConfigHome };

        expect(presetDirectoriesSource(locations).places[2]).toBe(
          path.join(locations.homeDirectory, '.config', 'jig', 'presets'),
        );
      },
    );

    it('looks in a directory two sources share once, however it was written', () => {
      const homeDirectory = faker.system.directoryPath();
      const starterDirectory = path.join(homeDirectory, '.jig', 'presets');
      const locations = {
        repoRoot: `${homeDirectory}${path.sep}.${path.sep}`,
        homeDirectory,
        xdgConfigHome: faker.system.directoryPath(),
      };

      expect(presetDirectoriesSource(locations, starterDirectory).places).toEqual([
        starterDirectory,
        path.join(locations.xdgConfigHome, 'jig', 'presets'),
      ]);
    });
  });

  describe('candidates', () => {
    it('lists the JSON files of every directory, highest precedence first and each by name', async () => {
      const { source, write } = await setup();
      const distinct = faker.helpers.uniqueArray(() => presetName(), 6);
      const [repositoryNames, xdgNames] = [distinct.slice(0, 3), distinct.slice(3)];
      for (const name of repositoryNames) await write('repository', `${name}.json`, '{}');
      for (const name of xdgNames) await write('xdg', `${name}.json`, '{}');
      await write('repository', `${faker.word.noun()}.md`, faker.lorem.paragraph());

      const candidates = unwrap(source.candidates());

      expect(candidates.map(({ name }) => name)).toEqual([
        ...[...repositoryNames].sort(),
        ...[...xdgNames].sort(),
      ]);
    });

    it('lists a file under the name its file gives it, valid or not, labelled with where it is', async () => {
      const { source, write } = await setup();
      const file = await write('home', 'Not Safe.json', '{}');

      const [candidate] = unwrap(source.candidates());

      expect(candidate).toMatchObject({
        name: 'Not Safe',
        label: { source: 'home', location: file, starter: false },
      });
    });

    it('orders names in a directory by name, not by file name', async () => {
      const { source, write } = await setup();
      const name = presetName();
      const longer = `${name}-${presetName()}`;
      await write('repository', `${longer}.json`, '{}');
      await write('repository', `${name}.json`, '{}');

      const candidates = unwrap(source.candidates());

      expect(candidates.map((candidate) => candidate.name)).toEqual([name, longer]);
    });

    it('labels the starters as starters', async () => {
      const { source, write } = await setup();
      await write('builtin', `${presetName()}.json`, '{}');

      const [candidate] = unwrap(source.candidates());

      expect(candidate?.label).toMatchObject({ source: 'builtin', starter: true });
    });

    it('lists nothing where there is no directory', async () => {
      const { source } = await setup();

      expect(unwrap(source.candidates())).toEqual([]);
    });

    it('refuses a preset directory that is a file', async () => {
      const { root } = await setup();
      const directoryAsFile = path.join(root.repoRoot, '.jig', 'presets');
      await mkdir(path.dirname(directoryAsFile), { recursive: true });
      await writeFile(directoryAsFile, '');

      const candidates = presetDirectoriesSource(root, root.starters).candidates();

      expect(candidates.isErr() && candidates.error).toBeInstanceOf(PresetsUnlistable);
      expect(candidates.isErr() && candidates.error.location).toBe(directoryAsFile);
    });

    it('refuses a preset directory under a path that is not a directory', async () => {
      const { root } = await setup();
      await writeFile(path.join(root.homeDirectory, '.jig'), '');

      const candidates = presetDirectoriesSource(root, root.starters).candidates();

      expect(candidates.isErr() && candidates.error).toBeInstanceOf(PresetNotFindable);
      expect(candidates.isErr() && candidates.error.location).toBe(
        path.join(root.homeDirectory, '.jig', 'presets'),
      );
    });

    it('refuses a preset directory that cannot be reached', async () => {
      const { root } = await setup();
      await symlink('.jig', path.join(root.repoRoot, '.jig'));

      const candidates = presetDirectoriesSource(root, root.starters).candidates();

      expect(candidates.isErr() && candidates.error).toBeInstanceOf(PresetNotFindable);
      expect(candidates.isErr() && candidates.error.location).toBe(
        path.join(root.repoRoot, '.jig', 'presets'),
      );
    });
  });

  describe('candidatesNamed', () => {
    it('yields the file of the name in each directory that has one, highest precedence first', async () => {
      const { source, write } = await setup();
      const name = presetName();
      const home = await write('home', `${name}.json`, '{}');
      const builtin = await write('builtin', `${name}.json`, '{}');
      await write('xdg', `${presetName()}.json`, '{}');

      const found = [...source.candidatesNamed(name)].map((candidate) => unwrap(candidate));

      expect(found.map(({ name: foundName, label }) => ({ name: foundName, label }))).toEqual([
        { name, label: { source: 'home', location: home, starter: false } },
        { name, label: { source: 'builtin', location: builtin, starter: true } },
      ]);
    });

    it('yields nothing when no directory has the name', async () => {
      const { source, write } = await setup();
      await write('repository', `${presetName()}.json`, '{}');

      expect([...source.candidatesNamed(presetName())]).toEqual([]);
    });

    it('counts a dangling link as present', async () => {
      const { source, linkDangling } = await setup();
      const name = presetName();
      const link = await linkDangling('repository', `${name}.json`);

      const [candidate] = source.candidatesNamed(name);

      expect(candidate && unwrap(candidate).label.location).toBe(link);
    });

    it('looks at no directory past the first that has the name', async () => {
      const { root, write } = await setup();
      const name = presetName();
      const winner = await write('repository', `${name}.json`, '{}');
      await writeFile(path.join(root.homeDirectory, '.jig'), '');

      const [candidate] = presetDirectoriesSource(root, root.starters).candidatesNamed(name);

      expect(candidate && unwrap(candidate).label.location).toBe(winner);
    });

    it('refuses rather than answers for a directory under a file, and looks no further', async () => {
      const { root, write } = await setup();
      const name = presetName();
      await writeFile(path.join(root.homeDirectory, '.jig'), '');
      await write('builtin', `${name}.json`, '{}');

      const found = [...presetDirectoriesSource(root, root.starters).candidatesNamed(name)];

      expect(found).toHaveLength(1);
      const [refused] = found;
      expect(refused?.isErr() && refused.error).toBeInstanceOf(PresetNotFindable);
      expect(refused?.isErr() && refused.error.location).toBe(
        path.join(root.homeDirectory, '.jig', 'presets', `${name}.json`),
      );
    });
  });

  describe('read', () => {
    it('reads the JSON a file holds', async () => {
      const { source, write } = await setup();
      const name = presetName();
      const contents = { planner: { provider: 'claude', model: faker.word.noun() } };
      await write('xdg', `${name}.json`, JSON.stringify(contents));

      expect(unwrap(onlyCandidate(source, name).read())).toEqual(contents);
    });

    it('refuses a file that is not JSON', async () => {
      const { source, write } = await setup();
      const name = presetName();
      const file = await write('repository', `${name}.json`, '{ "planner": ');

      const json = onlyCandidate(source, name).read();

      expect(json.isErr() && json.error).toBeInstanceOf(PresetNotJson);
      expect(json.isErr() && json.error.location).toBe(file);
    });

    it('refuses a path it cannot read as a file', async () => {
      const { source, places } = await setup();
      const name = presetName();
      const folder = path.join(places.repository, `${name}.json`);
      await mkdir(folder, { recursive: true });

      const json = onlyCandidate(source, name).read();

      expect(json.isErr() && json.error).toBeInstanceOf(PresetUnreadable);
      expect(json.isErr() && json.error.location).toBe(folder);
    });

    it('refuses a dangling link', async () => {
      const { source, linkDangling } = await setup();
      const name = presetName();
      const link = await linkDangling('home', `${name}.json`);

      const json = onlyCandidate(source, name).read();

      expect(json.isErr() && json.error).toBeInstanceOf(PresetUnreadable);
      expect(json.isErr() && json.error.location).toBe(link);
    });
  });

  describe('with preset policy', () => {
    it('lists every shipped starter as builtin, each with a description and an agent for each step', async () => {
      const locations = await emptyLocations();

      const presets = unwrap(discoverPresets(presetDirectoriesSource(locations)));

      expect(presets.map(({ name, label }) => ({ name, label }))).toEqual(
        SHIPPED_STARTERS.map((name) => ({
          name,
          label: {
            source: 'builtin',
            location: path.join(SHIPPED_PRESETS_DIRECTORY, `${name}.json`),
            starter: true,
          },
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

      const preset = unwrap(loadPreset(presetDirectoriesSource(locations), starter));

      expect(preset.label.source).toBe('repository');
      expect(preset.steps).toEqual({ reviewer: { provider: 'claude', model } });
    });

    it('refuses rather than falls back to the starter when the repository preset is a dangling link', async () => {
      const locations = await emptyLocations();
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
      const presets = path.join(locations.repoRoot, '.jig', 'presets');
      await mkdir(presets, { recursive: true });
      const winner = path.join(presets, `${starter}.json`);
      await symlink(path.join(presets, faker.string.uuid()), winner);

      const preset = loadPreset(presetDirectoriesSource(locations), starter);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(winner);
    });
  });

  async function setup() {
    const root = {
      repoRoot: await tempDirectory('jig-preset-repo-'),
      homeDirectory: await tempDirectory('jig-preset-home-'),
      xdgConfigHome: await tempDirectory('jig-preset-xdg-'),
      starters: await tempDirectory('jig-preset-starters-'),
    };
    const places = {
      repository: path.join(root.repoRoot, '.jig', 'presets'),
      home: path.join(root.homeDirectory, '.jig', 'presets'),
      xdg: path.join(root.xdgConfigHome, 'jig', 'presets'),
      builtin: root.starters,
    };
    const source = presetDirectoriesSource(root, root.starters);
    const write = async (place: keyof typeof places, fileName: string, contents: string) => {
      await mkdir(places[place], { recursive: true });
      const file = path.join(places[place], fileName);
      await writeFile(file, contents);
      return file;
    };
    const linkDangling = async (place: keyof typeof places, fileName: string) => {
      await mkdir(places[place], { recursive: true });
      const link = path.join(places[place], fileName);
      await symlink(path.join(places[place], faker.string.uuid()), link);
      return link;
    };
    return { root, places, source, write, linkDangling };
  }
});

function onlyCandidate(source: PresetSource, name: PresetName) {
  const [candidate] = source.candidatesNamed(name);
  return unwrap(candidate ?? panic(`No candidate named ${name}`));
}

function someLocations(): PresetLocations {
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
