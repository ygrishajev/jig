import { faker } from '@faker-js/faker';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { aPreset, aPresetLabel } from '../../../tests/support/builders.js';
import type { Preset } from '../../config/presets.js';
import { askForPreset } from './ask-for-preset.js';

const ENTER = '\r';
const DOWN = '\u001B[B';
const CTRL_C = '\u0003';

describe('askForPreset', () => {
  it('offers the project config with no preset as the first choice', async () => {
    const { answer, type } = setup({ presets: [aPreset(), aPreset()] });

    await type(ENTER);

    expect(await answer).toEqual({ kind: 'none' });
  });

  it('answers the name of the preset picked', async () => {
    const [first, second] = [aPreset(), aPreset()];
    const { answer, type } = setup({ presets: [first, second] });

    await type(DOWN, DOWN, ENTER);

    expect(await answer).toEqual({ kind: 'preset', name: second.name });
  });

  it('shows the description of the preset under the cursor', async () => {
    const description = faker.lorem.sentence(30);
    const { answer, type, shown } = setup({ presets: [aPreset({ description })] });

    await type(DOWN);

    await vi.waitFor(() =>
      expect(stripVTControlCharacters(shown()).replaceAll(/\s/g, '')).toContain(
        description.replaceAll(/\s/g, ''),
      ),
    );
    await type(CTRL_C);
    await answer;
  });

  it('labels a preset with its source unless it ships with jig', async () => {
    const operators = aPreset({ label: aPresetLabel({ starter: false }) });
    const starter = aPreset({ label: aPresetLabel({ starter: true }) });
    const { answer, type, shown } = setup({ presets: [operators, starter] });

    await type(CTRL_C);
    await answer;

    expect(shown()).toContain(`${operators.name} (${operators.label.source})`);
    expect(shown()).toContain(starter.name);
    expect(shown()).not.toContain(`${starter.name} (${starter.label.source})`);
  });

  it('answers nothing when cancelled', async () => {
    const { answer, type } = setup({ presets: [aPreset()] });

    await type(CTRL_C);

    expect(await answer).toBeUndefined();
  });

  it.each([
    ['input', { inputIsTTY: false, outputIsTTY: true }],
    ['output', { inputIsTTY: true, outputIsTTY: false }],
  ])('asks nothing when the %s is not a terminal', async (_stream, terminal) => {
    const { answer } = setup({ presets: [aPreset()], ...terminal });

    expect(await answer).toBeUndefined();
  });

  function setup(input: { presets: Preset[]; inputIsTTY?: boolean; outputIsTTY?: boolean }) {
    const stdin = Object.assign(new PassThrough(), { isTTY: input.inputIsTTY ?? true });
    const stdout = Object.assign(new PassThrough(), { isTTY: input.outputIsTTY ?? true });
    const chunks: string[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const answer = askForPreset(input.presets, { input: stdin, output: stdout });
    const type = async (...keys: string[]) => {
      for (const key of keys) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        stdin.write(key);
      }
    };
    return { answer, type, shown: () => chunks.join('') };
  }
});
