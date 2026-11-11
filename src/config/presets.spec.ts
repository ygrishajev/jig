import { faker } from '@faker-js/faker';
import { readdirSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { configFileFor, loadConfig } from './load-config.js';
import {
  configWithPreset,
  discoverPresets,
  loadPreset,
  type Preset,
  presetDirectories,
  type PresetLocations,
  type PresetName,
  presetNameSchema,
  type PresetSource,
} from './presets.js';

describe('presets', () => {
  describe('presetNameSchema', () => {
    it.each(['fast', 'cheap-review', 'opus-4', '2x'])('accepts %s', (name) => {
      expect(presetNameSchema.safeParse(name).success).toBe(true);
    });

    it.each([
      '',
      '../secrets',
      'nested/name',
      '.hidden',
      'Upper',
      'two--hyphens',
      '-leading',
      'a.b',
    ])('refuses %j', (name) => {
      expect(presetNameSchema.safeParse(name).success).toBe(false);
    });
  });

  describe('presetDirectories', () => {
    it('looks in the repository, the home directory, the XDG config directory, then the starters', async () => {
      const { locations } = await setup({ xdgConfigHome: 'set' });

      expect(presetDirectories(locations)).toEqual([
        { source: 'repository', path: path.join(locations.repoRoot, '.jig', 'presets') },
        { source: 'home', path: path.join(locations.homeDirectory, '.jig', 'presets') },
        { source: 'xdg', path: path.join(locations.xdgConfigHome ?? '', 'jig', 'presets') },
        { source: 'builtin', path: SHIPPED_PRESETS_DIRECTORY },
      ]);
    });

    it.each([undefined, '', 'relative/config'])(
      'falls back to ~/.config when XDG_CONFIG_HOME is %j',
      async (xdgConfigHome) => {
        const { locations } = await setup({ xdgConfigHome: 'unset' });

        const directories = presetDirectories({ ...locations, xdgConfigHome });

        expect(directories.find(({ source }) => source === 'xdg')).toEqual({
          source: 'xdg',
          path: path.join(locations.homeDirectory, '.config', 'jig', 'presets'),
        });
      },
    );

    it('names a directory once when the repository is the home directory', async () => {
      const { locations } = await setup({ xdgConfigHome: 'set' });

      const directories = presetDirectories({
        ...locations,
        repoRoot: `${locations.homeDirectory}${path.sep}`,
      });

      expect(directories.map(({ source }) => source)).toEqual(['repository', 'xdg', 'builtin']);
    });
  });

  describe('discoverPresets', () => {
    it('lists every shipped starter as builtin when the operator has no presets', async () => {
      const { locations } = await setup({ xdgConfigHome: 'set' });

      const presets = unwrap(discoverPresets(locations));

      expect(presets.map(({ name, source, path }) => ({ name, source, path }))).toEqual(
        SHIPPED_STARTERS.map((name) => ({
          name,
          source: 'builtin',
          path: path.join(SHIPPED_PRESETS_DIRECTORY, `${name}.json`),
        })),
      );
    });

    it('reads every starter with a description and an agent for each step', async () => {
      const { locations } = await setup({ xdgConfigHome: 'set' });

      const presets = unwrap(discoverPresets(locations));

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

    it('lists an operator preset in place of the starter of the same name', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
      await writePreset('xdg', starter, { planner: { provider: 'claude' } });

      const presets = unwrap(discoverPresets(locations));

      expect(presets.filter(({ name }) => name === starter).map(({ source }) => source)).toEqual([
        'xdg',
      ]);
      expect(presets).toHaveLength(SHIPPED_STARTERS.length);
    });

    it('refuses rather than lists the starter when an operator preset of its name is broken', async () => {
      const { locations, writeRaw } = await setup({ xdgConfigHome: 'set' });
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
      await writeRaw('home', `${starter}.json`, '{ not json');

      const presets = discoverPresets(locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(
        path.join(locations.homeDirectory, '.jig', 'presets', `${starter}.json`),
      );
    });

    it('collects presets from every directory with where each came from', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      const description = faker.lorem.sentence();
      const model = faker.word.noun();
      await writePreset('home', 'alpha', { description, reviewer: { provider: 'claude', model } });
      await writePreset('xdg', 'beta', { planner: { provider: 'codex' } });

      const presets = operatorPresets(unwrap(discoverPresets(locations)));

      expect(presets).toEqual([
        {
          name: 'alpha',
          source: 'home',
          path: path.join(locations.homeDirectory, '.jig', 'presets', 'alpha.json'),
          description,
          steps: { reviewer: { provider: 'claude', model } },
        },
        {
          name: 'beta',
          source: 'xdg',
          path: path.join(locations.xdgConfigHome ?? '', 'jig', 'presets', 'beta.json'),
          description: undefined,
          steps: { planner: { provider: 'codex' } },
        },
      ]);
    });

    it('lets the repository shadow a preset of the same name and skips the shadowed file', async () => {
      const { locations, writePreset, writeRaw } = await setup({ xdgConfigHome: 'set' });
      const model = faker.word.noun();
      await writePreset('repository', 'shared', { implementer: { provider: 'claude', model } });
      await writeRaw('home', 'shared.json', '{ not json');

      const presets = operatorPresets(unwrap(discoverPresets(locations)));

      expect(presets.map(({ name, source }) => ({ name, source }))).toEqual([
        { name: 'shared', source: 'repository' },
      ]);
      expect(presets[0]?.steps.implementer?.model).toBe(model);
    });

    it('keeps the repository preset winning even when it is invalid', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      await writePreset('repository', 'shared', { implementer: { provider: 'nobody' } });
      await writePreset('home', 'shared', { implementer: { provider: 'claude' } });

      const presets = discoverPresets(locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(
        path.join(locations.repoRoot, '.jig', 'presets', 'shared.json'),
      );
    });

    it('ignores files that are not presets or have names no one could ask for', async () => {
      const { locations, writePreset, writeRaw } = await setup({ xdgConfigHome: 'set' });
      await writePreset('repository', 'kept', { planner: { provider: 'claude' } });
      await writeRaw('repository', 'notes.md', faker.lorem.paragraph());
      await writeRaw('repository', 'Not Safe.json', '{ not json');

      const presets = operatorPresets(unwrap(discoverPresets(locations)));

      expect(presets.map(({ name }) => name)).toEqual(['kept']);
    });

    it('refuses a preset directory that cannot be listed', async () => {
      const { locations } = await setup({ xdgConfigHome: 'set' });
      await mkdir(path.join(locations.homeDirectory, '.jig'), { recursive: true });
      await writeFile(path.join(locations.homeDirectory, '.jig', 'presets'), '');

      const presets = discoverPresets(locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(
        path.join(locations.homeDirectory, '.jig', 'presets'),
      );
    });

    it('refuses rather than falls back when the repository presets cannot be looked at', async () => {
      const { locations, writePreset, makeRepositoryJigUnreachable } = await setup({
        xdgConfigHome: 'set',
      });
      await writePreset('home', 'shared', { planner: { provider: 'claude' } });
      await makeRepositoryJigUnreachable();

      const presets = discoverPresets(locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(
        path.join(locations.repoRoot, '.jig', 'presets'),
      );
    });

    it('keeps a dangling repository preset winning over the home one of the same name', async () => {
      const { locations, writePreset, linkDangling } = await setup({ xdgConfigHome: 'set' });
      await writePreset('home', 'shared', { planner: { provider: 'claude' } });
      const winner = await linkDangling('repository', 'shared.json');

      const presets = discoverPresets(locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(winner);
    });

    it('refuses rather than skips a preset directory under a path that is not a directory', async () => {
      const { locations, writePreset, makeHomeJigAFile } = await setup({ xdgConfigHome: 'set' });
      await writePreset('xdg', 'shared', { planner: { provider: 'claude' } });
      await makeHomeJigAFile();

      const presets = discoverPresets(locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(
        path.join(locations.homeDirectory, '.jig', 'presets'),
      );
    });
  });

  describe('loadPreset', () => {
    it('loads a starter by name from the package', async () => {
      const { locations } = await setup({ xdgConfigHome: 'set' });
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);

      const preset = unwrap(loadPreset(locations, starter));

      expect(preset).toMatchObject({
        name: starter,
        source: 'builtin',
        path: path.join(SHIPPED_PRESETS_DIRECTORY, `${starter}.json`),
      });
    });

    it('takes an operator preset over the starter of the same name', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
      const model = faker.word.noun();
      await writePreset('xdg', starter, { reviewer: { provider: 'claude', model } });

      const preset = unwrap(loadPreset(locations, starter));

      expect(preset.source).toBe('xdg');
      expect(preset.steps).toEqual({ reviewer: { provider: 'claude', model } });
    });

    it('refuses rather than falls back to the starter when an operator preset of its name is invalid', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      const starter = faker.helpers.arrayElement(SHIPPED_STARTERS);
      await writePreset('repository', starter, { planner: { provider: 'nobody' } });

      const preset = loadPreset(locations, starter);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(
        path.join(locations.repoRoot, '.jig', 'presets', `${starter}.json`),
      );
    });

    it('keeps a dangling repository preset winning over the home one of the same name', async () => {
      const { locations, writePreset, linkDangling } = await setup({ xdgConfigHome: 'set' });
      await writePreset('home', 'shared', { planner: { provider: 'claude' } });
      const winner = await linkDangling('repository', 'shared.json');

      const preset = loadPreset(locations, presetName('shared'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(winner);
    });

    it('refuses rather than falls back to the XDG preset when the home preset sits under a file', async () => {
      const { locations, writePreset, makeHomeJigAFile } = await setup({ xdgConfigHome: 'set' });
      await writePreset('xdg', 'shared', { planner: { provider: 'claude' } });
      await makeHomeJigAFile();

      const preset = loadPreset(locations, presetName('shared'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(
        path.join(locations.homeDirectory, '.jig', 'presets', 'shared.json'),
      );
    });

    it('loads a preset from the XDG config directory', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      const model = faker.word.noun();
      await writePreset('xdg', 'remote', { describer: { provider: 'opencode', model } });

      const preset = unwrap(loadPreset(locations, presetName('remote')));

      expect(preset.source).toBe('xdg');
      expect(preset.steps).toEqual({ describer: { provider: 'opencode', model } });
    });

    it('takes the home preset over the XDG one of the same name', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      await writePreset('home', 'shared', { planner: { provider: 'claude' } });
      await writePreset('xdg', 'shared', { planner: { provider: 'codex' } });

      const preset = unwrap(loadPreset(locations, presetName('shared')));

      expect(preset.source).toBe('home');
    });

    it('keeps the repository preset winning even when it is malformed', async () => {
      const { locations, writePreset, writeRaw } = await setup({ xdgConfigHome: 'set' });
      await writeRaw('repository', 'shared.json', '{ not json');
      await writePreset('home', 'shared', { planner: { provider: 'claude' } });

      const preset = loadPreset(locations, presetName('shared'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(
        path.join(locations.repoRoot, '.jig', 'presets', 'shared.json'),
      );
    });

    it('refuses rather than falls back to the home preset when the repository one cannot be looked at', async () => {
      const { locations, writePreset, makeRepositoryJigUnreachable } = await setup({
        xdgConfigHome: 'set',
      });
      await writePreset('home', 'shared', { planner: { provider: 'claude' } });
      await makeRepositoryJigUnreachable();

      const preset = loadPreset(locations, presetName('shared'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(
        path.join(locations.repoRoot, '.jig', 'presets', 'shared.json'),
      );
    });

    it('loads a preset while an unrelated one is malformed', async () => {
      const { locations, writePreset, writeRaw } = await setup({ xdgConfigHome: 'set' });
      await writeRaw('repository', 'broken.json', '{ not json');
      await writePreset('home', 'wanted', { planner: { provider: 'claude' } });

      const preset = unwrap(loadPreset(locations, presetName('wanted')));

      expect(preset.name).toBe('wanted');
    });

    it.each([
      ['an unknown top-level key', { planer: { provider: 'claude' } }, 'planer'],
      ['an unknown step key', { planner: { provider: 'claude', modle: 'opus' } }, 'modle'],
      ['a project setting', { mergeMode: 'auto' }, 'mergeMode'],
      ['an unknown agent', { planner: { provider: 'nobody' } }, 'planner.provider'],
    ])('refuses a preset with %s', async (_, contents, offendingKey) => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      await writePreset('repository', 'strict', contents);

      const preset = loadPreset(locations, presetName('strict'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(offendingKey);
    });

    it('refuses a preset that is not JSON', async () => {
      const { locations, writeRaw } = await setup({ xdgConfigHome: 'set' });
      await writeRaw('home', 'broken.json', '{ "planner": ');

      const preset = loadPreset(locations, presetName('broken'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(
        path.join(locations.homeDirectory, '.jig', 'presets', 'broken.json'),
      );
    });

    it('refuses a preset path it cannot read', async () => {
      const { locations } = await setup({ xdgConfigHome: 'set' });
      await mkdir(path.join(locations.repoRoot, '.jig', 'presets', 'folder.json'), {
        recursive: true,
      });

      const preset = loadPreset(locations, presetName('folder'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(
        path.join(locations.repoRoot, '.jig', 'presets', 'folder.json'),
      );
    });

    it('names where it looked and what exists when no preset has the name', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      await writePreset('repository', 'first', { planner: { provider: 'claude' } });
      await writePreset('xdg', 'second', { planner: { provider: 'claude' } });

      const preset = loadPreset(locations, presetName('missing'));

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      const message = preset.isErr() ? preset.error.message : '';
      expect(message).toContain('missing');
      for (const directory of presetDirectories(locations))
        expect(message).toContain(directory.path);
      expect(message).toContain('first, second');
    });
  });

  describe('configWithPreset', () => {
    it('replaces the steps the preset names and keeps the project settings and other steps', async () => {
      const { locations, writePreset, writeProjectConfig } = await setup({ xdgConfigHome: 'set' });
      const verifyCommand = `npm run ${faker.word.verb()}`;
      const reviewCycleCap = faker.number.int({ min: 1, max: 9 });
      const plannerModel = faker.word.noun();
      await writeProjectConfig({
        mergeMode: 'auto',
        verifyCommand,
        reviewCycleCap,
        planner: { provider: 'claude', model: plannerModel },
        implementer: { provider: 'opencode', model: `openrouter/${faker.word.noun()}` },
      });
      await writePreset('home', 'swap', { implementer: { provider: 'claude' } });
      const config = unwrap(loadConfig(configFileFor(locations.repoRoot)));

      const applied = unwrap(configWithPreset(config, locations, presetName('swap')));

      expect(applied).toEqual({
        ...config,
        implementer: { provider: 'claude' },
      });
      expect(applied).toMatchObject({
        mergeMode: 'auto',
        verifyCommand,
        reviewCycleCap,
        planner: { provider: 'claude', model: plannerModel },
      });
      expect(applied.implementer).not.toHaveProperty('model');
    });

    it('adds a step the project left unset', async () => {
      const { locations, writePreset } = await setup({ xdgConfigHome: 'set' });
      const model = faker.word.noun();
      await writePreset('repository', 'add', { reviewer: { provider: 'claude', model } });
      const config = unwrap(loadConfig(configFileFor(locations.repoRoot)));

      const applied = unwrap(configWithPreset(config, locations, presetName('add')));

      expect(applied.reviewer).toEqual({ provider: 'claude', model });
      expect(applied.planner).toBeUndefined();
    });

    it("keeps the project's config as it is when no preset is named", async () => {
      const { locations, writeProjectConfig } = await setup({ xdgConfigHome: 'set' });
      await writeProjectConfig({ reviewer: { provider: 'claude', model: faker.word.noun() } });
      const config = unwrap(loadConfig(configFileFor(locations.repoRoot)));

      expect(unwrap(configWithPreset(config, locations, undefined))).toBe(config);
    });

    it('refuses rather than runs on the project agents when the named preset does not load', async () => {
      const { locations, writeRaw } = await setup({ xdgConfigHome: 'set' });
      await writeRaw('home', 'broken.json', '{ not json');
      const config = unwrap(loadConfig(configFileFor(locations.repoRoot)));

      const applied = configWithPreset(config, locations, presetName('broken'));

      expect(applied.isErr() && applied.error).toBeInstanceOf(ConfigInvalid);
    });
  });

  async function setup(input: { xdgConfigHome: 'set' | 'unset' }) {
    const locations: PresetLocations = {
      repoRoot: await tempDirectory('jig-preset-repo-'),
      homeDirectory: await tempDirectory('jig-preset-home-'),
      xdgConfigHome:
        input.xdgConfigHome === 'set' ? await tempDirectory('jig-preset-xdg-') : undefined,
    };
    const directoryOf = (source: PresetSource) =>
      presetDirectories(locations).find((directory) => directory.source === source)?.path ?? '';
    const writeRaw = async (source: PresetSource, fileName: string, contents: string) => {
      await mkdir(directoryOf(source), { recursive: true });
      await writeFile(path.join(directoryOf(source), fileName), contents);
    };
    const writePreset = (source: PresetSource, name: string, contents: unknown) =>
      writeRaw(source, `${name}.json`, JSON.stringify(contents));
    const writeProjectConfig = (contents: unknown) =>
      writeFile(configFileFor(locations.repoRoot).path, JSON.stringify(contents));
    const makeRepositoryJigUnreachable = () =>
      symlink('.jig', path.join(locations.repoRoot, '.jig'));
    const linkDangling = async (source: PresetSource, fileName: string) => {
      const link = path.join(directoryOf(source), fileName);
      await mkdir(directoryOf(source), { recursive: true });
      await symlink(path.join(directoryOf(source), faker.string.uuid()), link);
      return link;
    };
    const makeHomeJigAFile = () => writeFile(path.join(locations.homeDirectory, '.jig'), '');
    return {
      locations,
      writePreset,
      writeRaw,
      writeProjectConfig,
      makeRepositoryJigUnreachable,
      linkDangling,
      makeHomeJigAFile,
    };
  }
});

function presetName(name: string): PresetName {
  return presetNameSchema.parse(name);
}

function operatorPresets(presets: Preset[]): Preset[] {
  return presets.filter(({ source }) => source !== 'builtin');
}

/** Read from the repository's own `presets/`, not through the module, so the spec checks where the module looks. */
const SHIPPED_PRESETS_DIRECTORY = fileURLToPath(new URL('../../presets', import.meta.url));

const SHIPPED_STARTERS = readdirSync(SHIPPED_PRESETS_DIRECTORY)
  .map((entry) => presetName(path.basename(entry, '.json')))
  .sort();
