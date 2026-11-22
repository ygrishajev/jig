import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { presetName } from '../../tests/support/builders.js';
import { FakePresetFiles } from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { configFileFor, configFrom, runSettingsFrom } from './load-config.js';
import {
  configWithPreset,
  discoverPresets,
  loadPreset,
  presetDirectories,
  type PresetLocations,
  presetNameSchema,
  type PresetSource,
} from './presets.js';

/** Written out here, not taken from production, so a reordering of the sources fails these specs. */
const PRECEDENCE: PresetSource[] = ['repository', 'home', 'xdg', 'builtin'];

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
      'a'.repeat(65),
    ])('refuses %j', (name) => {
      expect(presetNameSchema.safeParse(name).success).toBe(false);
    });
  });

  describe('presetDirectories', () => {
    it('looks in the repository, the home directory, the XDG config directory, then the starters', () => {
      const { files, locations } = setup({});

      expect(presetDirectories(files, locations)).toEqual([
        { source: 'repository', path: files.paths.repository },
        { source: 'home', path: files.paths.home },
        { source: 'xdg', path: files.paths.xdg },
        { source: 'builtin', path: files.paths.builtin },
      ]);
    });

    it('asks for the directories under the repository, the home directory and an absolute XDG config home', () => {
      const { files, locations } = setup({});

      presetDirectories(files, locations);

      expect(files.rootsGiven).toEqual([locations]);
    });

    it.each([undefined, '', 'relative/config'])(
      'leaves the XDG config home to its default when XDG_CONFIG_HOME is %j',
      (xdgConfigHome) => {
        const { files, locations } = setup({ xdgConfigHome });

        presetDirectories(files, locations);

        expect(files.rootsGiven).toEqual([
          {
            repoRoot: locations.repoRoot,
            homeDirectory: locations.homeDirectory,
            xdgConfigHome: undefined,
          },
        ]);
      },
    );

    it('names a directory two sources share once, for the one that takes precedence', () => {
      const shared = faker.system.directoryPath();
      const { files, locations } = setup({
        paths: { home: shared, builtin: shared },
      });

      expect(presetDirectories(files, locations)).toEqual([
        { source: 'repository', path: files.paths.repository },
        { source: 'home', path: shared },
        { source: 'xdg', path: files.paths.xdg },
      ]);
    });
  });

  describe('discoverPresets', () => {
    it('collects presets from every directory with where each came from', () => {
      const { files, locations } = setup({});
      const description = faker.lorem.sentence();
      const model = faker.word.noun();
      const alpha = files.put('home', 'alpha', {
        description,
        reviewer: { provider: 'claude', model },
      });
      const beta = files.put('xdg', 'beta', { planner: { provider: 'codex' } });

      const presets = unwrap(discoverPresets(files, locations));

      expect(presets).toEqual([
        {
          name: 'alpha',
          source: 'home',
          path: alpha,
          description,
          steps: { reviewer: { provider: 'claude', model } },
        },
        {
          name: 'beta',
          source: 'xdg',
          path: beta,
          description: undefined,
          steps: { planner: { provider: 'codex' } },
        },
      ]);
    });

    it('lists the presets of a directory by name', () => {
      const { files, locations } = setup({});
      const names = faker.helpers.uniqueArray(() => presetName(), 5);
      for (const name of names) files.put('repository', name, {});

      const presets = unwrap(discoverPresets(files, locations));

      expect(presets.map(({ name }) => name)).toEqual([...names].sort());
    });

    it('lists only the highest-precedence preset of a name and never reads the ones it shadows', () => {
      const { files, locations } = setup({});
      const chosen = faker.helpers.arrayElements(PRECEDENCE, { min: 2, max: 4 });
      const sources = PRECEDENCE.filter((source) => chosen.includes(source));
      const name = presetName();
      const [winner, ...shadowed] = sources.map((source) => ({
        source,
        path: files.put(source, name, {}),
      }));

      const presets = unwrap(discoverPresets(files, locations));

      expect(presets.map(({ source, path }) => ({ source, path }))).toEqual([winner]);
      expect(files.readFiles).toEqual([winner?.path]);
      expect(shadowed).not.toHaveLength(0);
    });

    it('refuses rather than lists a lower-precedence preset when the winner cannot be read', () => {
      const { files, locations } = setup({});
      const name = presetName();
      const winner = files.putUnreadable('home', name);
      files.put('builtin', name, {});

      const presets = discoverPresets(files, locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(winner);
    });

    it('refuses rather than lists a lower-precedence preset when the winner is invalid', () => {
      const { files, locations } = setup({});
      const name = presetName();
      const winner = files.put('repository', name, { implementer: { provider: 'nobody' } });
      files.put('home', name, { implementer: { provider: 'claude' } });

      const presets = discoverPresets(files, locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(winner);
    });

    it('ignores files with names no one could ask for, without reading them', () => {
      const { files, locations } = setup({});
      const kept = presetName();
      files.put('repository', kept, {});
      files.putUnreadable('repository', 'Not Safe');

      const presets = unwrap(discoverPresets(files, locations));

      expect(presets.map(({ name }) => name)).toEqual([kept]);
      expect(files.readFiles).toHaveLength(1);
    });

    it.each(PRECEDENCE)('refuses when the %s directory cannot be listed', (source) => {
      const { files, locations } = setup({});
      files.makeUnlistable(source);

      const presets = discoverPresets(files, locations);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(files.paths[source]);
    });

    it('discovers model-less providers without constructing or authenticating them', () => {
      const { files, locations } = setup({});
      const steps = {
        planner: { provider: 'claude' },
        implementer: { provider: 'codex' },
        reviewer: { provider: 'opencode' },
      };
      const name = presetName();
      files.put('repository', name, steps);

      const presets = unwrap(discoverPresets(files, locations));

      expect(presets.find((preset) => preset.name === name)?.steps).toEqual(steps);
    });
  });

  describe('loadPreset', () => {
    it.each(precedencePairs())(
      'takes the %s preset over the %s one of the same name',
      (higher, lower) => {
        const { files, locations } = setup({});
        const name = presetName();
        const model = faker.word.noun();
        files.put(lower, name, { planner: { provider: 'codex' } });
        const winner = files.put(higher, name, { reviewer: { provider: 'claude', model } });

        const preset = unwrap(loadPreset(files, locations, name));

        expect(preset).toEqual({
          name,
          source: higher,
          path: winner,
          description: undefined,
          steps: { reviewer: { provider: 'claude', model } },
        });
      },
    );

    it('reads only the winning file and lists no directory', () => {
      const { files, locations } = setup({});
      const name = presetName();
      files.putUnreadable('repository', presetName());
      const winner = files.put('xdg', name, {});
      files.put('builtin', name, {});

      unwrap(loadPreset(files, locations, name));

      expect(files.readFiles).toEqual([winner]);
      expect(files.listed).toEqual([]);
    });

    it('refuses rather than falls back when the winner is present but cannot be read', () => {
      const { files, locations } = setup({});
      const name = presetName();
      const winner = files.putUnreadable('repository', name);
      files.put('home', name, {});

      const preset = loadPreset(files, locations, name);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(winner);
    });

    it('refuses rather than falls back when a higher-precedence directory cannot be looked at', () => {
      const { files, locations } = setup({});
      const name = presetName();
      files.makeUnreachable('home');
      files.put('xdg', name, {});

      const preset = loadPreset(files, locations, name);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(
        files.fileFor(files.paths.home, name),
      );
    });

    it.each([
      ['an unknown top-level key', { planer: { provider: 'claude' } }, 'planer'],
      ['an unknown step key', { planner: { provider: 'claude', modle: 'opus' } }, 'modle'],
      ['a project setting', { mergeMode: 'auto' }, 'mergeMode'],
      ['an unknown agent', { planner: { provider: 'nobody' } }, 'planner.provider'],
    ])('refuses a preset with %s', (_, contents, offendingKey) => {
      const { files, locations } = setup({});
      const name = presetName();
      const file = files.put('repository', name, contents);

      const preset = loadPreset(files, locations, name);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(offendingKey);
      expect(preset.isErr() && preset.error.message).toContain(file);
    });

    it('names where it looked and the winning presets there when no preset has the name', () => {
      const { files, locations } = setup({});
      const [first, second] = faker.helpers.uniqueArray(() => presetName(), 2);
      files.put('repository', first, {});
      files.put('xdg', second, {});
      files.put('builtin', first, {});
      const missing = presetName();

      const preset = loadPreset(files, locations, missing);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      const message = preset.isErr() ? preset.error.message : '';
      expect(message).toContain(missing);
      for (const source of PRECEDENCE) expect(message).toContain(files.paths[source]);
      expect(message).toContain(`${first}, ${second}.`);
    });

    it('refuses with the listing failure when it cannot say which presets exist', () => {
      const { files, locations } = setup({});
      files.makeUnlistable('home');

      const preset = loadPreset(files, locations, presetName());

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(files.paths.home);
    });
  });

  describe('configWithPreset', () => {
    it('replaces the steps the preset names and keeps every run setting and other step', () => {
      const { files, locations, projectConfig } = setup({});
      const config = projectConfig({
        mergeMode: faker.helpers.arrayElement(['manual', 'auto']),
        reviewCycleCap: faker.number.int({ min: 1, max: 9 }),
        designGate: faker.helpers.arrayElement(['auto', 'checkpoint']),
        verifyCommand: `npm run ${faker.word.verb()}`,
        setupCommand: `npm ${faker.word.verb()}`,
        planner: { provider: 'claude', model: faker.word.noun() },
        implementer: { provider: 'opencode', model: `openrouter/${faker.word.noun()}` },
      });
      const name = presetName();
      files.put('home', name, { implementer: { provider: 'claude' } });

      const applied = unwrap(configWithPreset(config, files, locations, name));

      expect(applied).toEqual({ ...config, implementer: { provider: 'claude' } });
      expect(runSettingsFrom(applied)).toEqual(runSettingsFrom(config));
    });

    it('adds a step the project left unset', () => {
      const { files, locations, projectConfig } = setup({});
      const model = faker.word.noun();
      const name = presetName();
      files.put('repository', name, { reviewer: { provider: 'claude', model } });

      const applied = unwrap(configWithPreset(projectConfig({}), files, locations, name));

      expect(applied.reviewer).toEqual({ provider: 'claude', model });
      expect(applied.planner).toBeUndefined();
    });

    it("keeps the project's config as it is and touches no preset when none is named", () => {
      const { files, locations, projectConfig } = setup({});
      const config = projectConfig({ reviewer: { provider: 'claude', model: faker.word.noun() } });

      expect(unwrap(configWithPreset(config, files, locations, undefined))).toBe(config);
      expect(files.rootsGiven).toEqual([]);
    });

    it('refuses rather than runs on the project agents when the named preset does not load', () => {
      const { files, locations, projectConfig } = setup({});
      const name = presetName();
      files.putUnreadable('home', name);

      const applied = configWithPreset(projectConfig({}), files, locations, name);

      expect(applied.isErr() && applied.error).toBeInstanceOf(ConfigInvalid);
    });
  });

  function setup(input: { xdgConfigHome?: string; paths?: Partial<Record<PresetSource, string>> }) {
    const files = new FakePresetFiles(input.paths);
    const locations: PresetLocations = {
      repoRoot: faker.system.directoryPath(),
      homeDirectory: faker.system.directoryPath(),
      xdgConfigHome: 'xdgConfigHome' in input ? input.xdgConfigHome : faker.system.directoryPath(),
    };
    const projectConfig = (contents: Record<string, unknown>) =>
      unwrap(configFrom(configFileFor(locations.repoRoot), contents));
    return { files, locations, projectConfig };
  }
});

function precedencePairs(): [PresetSource, PresetSource][] {
  return [
    ['repository', 'home'],
    ['repository', 'xdg'],
    ['repository', 'builtin'],
    ['home', 'xdg'],
    ['home', 'builtin'],
    ['xdg', 'builtin'],
  ];
}
