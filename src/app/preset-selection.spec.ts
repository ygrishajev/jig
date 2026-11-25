import { faker } from '@faker-js/faker';
import { describe, expect, it, vi } from 'vitest';

import { aJigConfig, everyStepOn, presetName } from '../../tests/support/builders.js';
import { InMemoryPresetSource } from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../config/errors.js';
import type { PresetPick } from '../config/presets.js';
import { configWithSelectedPreset, type PresetChooser } from './preset-selection.js';

describe('configWithSelectedPreset', () => {
  it('keeps the config and asks for nothing when no preset is wanted', async () => {
    const { select, config, askForPreset } = setup();

    expect(unwrap(await select(undefined))).toEqual({ config, presetName: undefined });
    expect(askForPreset).not.toHaveBeenCalled();
  });

  it('applies the named preset without asking', async () => {
    const { select, name, reviewer, askForPreset } = setup();

    const selected = unwrap(await select({ kind: 'named', name }));

    expect(selected).toMatchObject({ config: { reviewer }, presetName: name });
    expect(askForPreset).not.toHaveBeenCalled();
  });

  it('applies the preset the operator picks from those found', async () => {
    const { select, name, reviewer, askForPreset } = setup({ pick: 'preset' });

    const selected = unwrap(await select({ kind: 'ask' }));

    expect(selected).toMatchObject({ config: { reviewer }, presetName: name });
    expect(askForPreset.mock.calls[0]?.[0].map((preset) => preset.name)).toEqual([name]);
  });

  it('keeps the config when the operator picks to use none', async () => {
    const { select, config } = setup({ pick: 'none' });

    expect(unwrap(await select({ kind: 'ask' }))).toEqual({ config, presetName: undefined });
  });

  it('refuses when nobody picks', async () => {
    const { select, askForPreset } = setup();

    const result = await select({ kind: 'ask' });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(askForPreset).toHaveBeenCalledOnce();
  });

  it('refuses without asking when there is no preset to pick', async () => {
    const { select, askForPreset } = setup({ empty: true, pick: 'none' });

    const result = await select({ kind: 'ask' });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(askForPreset).not.toHaveBeenCalled();
  });

  function setup(input: { empty?: boolean; pick?: PresetPick['kind'] } = {}) {
    const name = presetName();
    const reviewer = { provider: 'codex', model: faker.word.noun() } as const;
    const presetSource = new InMemoryPresetSource();
    if (!input.empty) presetSource.put(0, name, { reviewer });
    const config = aJigConfig(everyStepOn());
    const pick: PresetPick | undefined =
      input.pick === 'preset' ? { kind: 'preset', name } : input.pick && { kind: 'none' };
    const askForPreset = vi.fn<PresetChooser['askForPreset']>(async () => pick);
    return {
      name,
      reviewer,
      config,
      askForPreset,
      select: (selection: Parameters<typeof configWithSelectedPreset>[1]) =>
        configWithSelectedPreset({ config, presetSource }, selection, { askForPreset }),
    };
  }
});
