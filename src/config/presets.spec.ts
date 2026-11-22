import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { presetName } from '../../tests/support/builders.js';
import { InMemoryConfigSource, InMemoryPresetSource } from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { loadConfig, runSettingsFrom } from './load-config.js';
import { configWithPreset, discoverPresets, loadPreset, presetNameSchema } from './presets.js';

const PLACE_COUNT = 4;

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

  describe('discoverPresets', () => {
    it('collects the presets of every place with the label each was found under', () => {
      const { source } = setup();
      const description = faker.lorem.sentence();
      const model = faker.word.noun();
      const [first, second] = faker.helpers.uniqueArray(() => presetName(), 2);
      const firstLabel = source.put(1, first, {
        description,
        reviewer: { provider: 'claude', model },
      });
      const secondLabel = source.put(2, second, { planner: { provider: 'codex' } });

      const presets = unwrap(discoverPresets(source));

      expect(presets).toEqual([
        {
          name: first,
          label: firstLabel,
          description,
          steps: { reviewer: { provider: 'claude', model } },
        },
        {
          name: second,
          label: secondLabel,
          description: undefined,
          steps: { planner: { provider: 'codex' } },
        },
      ]);
    });

    it('lists the presets in the order the source gives them', () => {
      const { source } = setup();
      const names = faker.helpers.uniqueArray(() => presetName(), 6);
      const [lower, higher] = [names.slice(0, 3), names.slice(3)];
      for (const name of lower) source.put(3, name, {});
      for (const name of higher) source.put(0, name, {});

      const presets = unwrap(discoverPresets(source));

      expect(presets.map(({ name }) => name)).toEqual([
        ...[...higher].sort(),
        ...[...lower].sort(),
      ]);
    });

    it('lists only the highest-precedence preset of a name and never reads the ones it shadows', () => {
      const { source } = setup();
      const ranks = faker.helpers
        .arrayElements([0, 1, 2, 3], { min: 2, max: 4 })
        .sort((first, second) => first - second);
      const name = presetName();
      const [winner, ...shadowed] = ranks.map((rank) => source.put(rank, name, {}));

      const presets = unwrap(discoverPresets(source));

      expect(presets.map(({ label }) => label)).toEqual([winner]);
      expect(source.readPaths).toEqual([winner?.path]);
      expect(shadowed).not.toHaveLength(0);
    });

    it('refuses rather than lists a lower-precedence preset when the winner cannot be read', () => {
      const { source } = setup();
      const name = presetName();
      const winner = source.putUnreadable(1, name);
      source.put(3, name, {});

      const presets = discoverPresets(source);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(winner.path);
    });

    it('refuses rather than lists a lower-precedence preset when the winner is invalid', () => {
      const { source } = setup();
      const name = presetName();
      const winner = source.put(0, name, { implementer: { provider: 'nobody' } });
      source.put(1, name, { implementer: { provider: 'claude' } });

      const presets = discoverPresets(source);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(winner.path);
    });

    it('ignores candidates with names no one could ask for, without reading them', () => {
      const { source } = setup();
      const kept = presetName();
      const keptLabel = source.put(1, kept, {});
      source.putUnreadable(0, 'Not Safe');

      const presets = unwrap(discoverPresets(source));

      expect(presets.map(({ name }) => name)).toEqual([kept]);
      expect(source.readPaths).toEqual([keptLabel.path]);
    });

    const breakages = [
      ['listed', (source: InMemoryPresetSource, rank: number) => source.makeUnlistable(rank)],
      ['looked at', (source: InMemoryPresetSource, rank: number) => source.makeUnfindable(rank)],
    ] as const;

    it.each(
      breakages.flatMap(([kind, breakPlace]) =>
        Array.from({ length: PLACE_COUNT }, (_, rank) => ({ kind, rank, breakPlace })),
      ),
    )('refuses when the place at rank $rank cannot be $kind', ({ rank, breakPlace }) => {
      const { source } = setup();
      breakPlace(source, rank);

      const presets = discoverPresets(source);

      expect(presets.isErr() && presets.error).toBeInstanceOf(ConfigInvalid);
      expect(presets.isErr() && presets.error.message).toContain(source.placeAt(rank));
    });

    it('discovers model-less providers without constructing or authenticating them', () => {
      const { source } = setup();
      const steps = {
        planner: { provider: 'claude' },
        implementer: { provider: 'codex' },
        reviewer: { provider: 'opencode' },
      };
      const name = presetName();
      source.put(0, name, steps);

      const presets = unwrap(discoverPresets(source));

      expect(presets.find((preset) => preset.name === name)?.steps).toEqual(steps);
    });
  });

  describe('loadPreset', () => {
    it.each(precedencePairs())(
      'takes the preset of the place ranked %i over the one ranked %i',
      (higher, lower) => {
        const { source } = setup();
        const name = presetName();
        const model = faker.word.noun();
        source.put(lower, name, { planner: { provider: 'codex' } });
        const winner = source.put(higher, name, { reviewer: { provider: 'claude', model } });

        const preset = unwrap(loadPreset(source, name));

        expect(preset).toEqual({
          name,
          label: winner,
          description: undefined,
          steps: { reviewer: { provider: 'claude', model } },
        });
      },
    );

    it('reads only the winner, looks in no place after it and lists nothing', () => {
      const { source } = setup();
      const name = presetName();
      source.putUnreadable(0, presetName());
      source.putUnreadable(1, 'Not Safe');
      const winner = source.put(2, name, {});
      source.putUnreadable(3, name);
      source.makeUnlistable(3);

      unwrap(loadPreset(source, name));

      expect(source.readPaths).toEqual([winner.path]);
      expect(source.lookedIn).toEqual(source.places.slice(0, 3));
      expect(source.listings).toBe(0);
    });

    it('refuses rather than falls back when the winner is present but cannot be read', () => {
      const { source } = setup();
      const name = presetName();
      const winner = source.putUnreadable(0, name);
      source.put(1, name, {});

      const preset = loadPreset(source, name);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(winner.path);
      expect(source.readPaths).toEqual([winner.path]);
    });

    it('refuses rather than falls back when a higher-precedence place cannot be looked at', () => {
      const { source } = setup();
      const name = presetName();
      source.makeUnfindable(1);
      source.put(2, name, {});

      const preset = loadPreset(source, name);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(source.placeAt(1));
      expect(source.readPaths).toEqual([]);
    });

    it.each([
      ['an unknown top-level key', { planer: { provider: 'claude' } }, 'planer'],
      ['an unknown step key', { planner: { provider: 'claude', modle: 'opus' } }, 'modle'],
      ['a project setting', { mergeMode: 'auto' }, 'mergeMode'],
      ['a review cap', { reviewCycleCap: 5 }, 'reviewCycleCap'],
      ['a step retry count', { maxStepRetries: 1 }, 'maxStepRetries'],
      ['a retry delay', { retryDelayMs: 1000 }, 'retryDelayMs'],
      ['an unknown agent', { planner: { provider: 'nobody' } }, 'planner.provider'],
    ])('refuses a preset with %s', (_, contents, offendingKey) => {
      const { source } = setup();
      const name = presetName();
      const label = source.put(0, name, contents);

      const preset = loadPreset(source, name);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(offendingKey);
      expect(preset.isErr() && preset.error.message).toContain(label.path);
    });

    it('names every place it looked in and the winning presets there when no preset has the name', () => {
      const { source } = setup();
      const [first, second] = faker.helpers.uniqueArray(() => presetName(), 2).sort();
      source.put(0, first, {});
      source.put(2, second, {});
      source.putUnreadable(3, first);
      source.putUnreadable(1, 'Not Safe');
      const missing = presetName();

      const preset = loadPreset(source, missing);

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      const message = preset.isErr() ? preset.error.message : '';
      expect(message).toContain(missing);
      expect(message).toContain(source.places.join(', '));
      expect(message).toContain(`${first}, ${second}.`);
      expect(source.readPaths).toEqual([]);
    });

    it('refuses with the listing failure when it cannot say which presets exist', () => {
      const { source } = setup();
      const rank = faker.number.int({ min: 0, max: PLACE_COUNT - 1 });
      source.makeUnlistable(rank);

      const preset = loadPreset(source, presetName());

      expect(preset.isErr() && preset.error).toBeInstanceOf(ConfigInvalid);
      expect(preset.isErr() && preset.error.message).toContain(source.placeAt(rank));
    });
  });

  describe('configWithPreset', () => {
    it('replaces the steps the preset names and keeps every run setting and other step', () => {
      const { source, projectConfig } = setup();
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
      source.put(1, name, { implementer: { provider: 'claude' } });

      const applied = unwrap(configWithPreset(config, source, name));

      expect(applied).toEqual({ ...config, implementer: { provider: 'claude' } });
      expect(runSettingsFrom(applied)).toEqual(runSettingsFrom(config));
    });

    it('adds a step the project left unset', () => {
      const { source, projectConfig } = setup();
      const model = faker.word.noun();
      const name = presetName();
      source.put(0, name, { reviewer: { provider: 'claude', model } });

      const applied = unwrap(configWithPreset(projectConfig({}), source, name));

      expect(applied.reviewer).toEqual({ provider: 'claude', model });
      expect(applied.planner).toBeUndefined();
    });

    it("keeps the project's config as it is and touches no preset when none is named", () => {
      const { source, projectConfig } = setup();
      const config = projectConfig({ reviewer: { provider: 'claude', model: faker.word.noun() } });

      expect(unwrap(configWithPreset(config, source, undefined))).toBe(config);
      expect(source.lookedIn).toEqual([]);
      expect(source.listings).toBe(0);
    });

    it('refuses rather than runs on the project agents when the named preset does not load', () => {
      const { source, projectConfig } = setup();
      const name = presetName();
      source.putUnreadable(1, name);

      const applied = configWithPreset(projectConfig({}), source, name);

      expect(applied.isErr() && applied.error).toBeInstanceOf(ConfigInvalid);
    });
  });

  function setup() {
    const source = new InMemoryPresetSource(PLACE_COUNT);
    const projectConfig = (contents: Record<string, unknown>) =>
      unwrap(loadConfig(new InMemoryConfigSource({ json: contents })));
    return { source, projectConfig };
  }
});

function precedencePairs(): [number, number][] {
  return [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ];
}
