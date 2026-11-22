import { faker } from '@faker-js/faker';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { presetName } from '../../../tests/support/builders.js';
import { fakeStandardInput } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { presetFilesOnDisk } from '../../adapters/config/preset-files.js';
import { configFileSource } from '../../adapters/filesystem/config-source.js';
import { createAppContainer } from '../../app/container.js';
import type { Preset, PresetName } from '../../config/presets.js';
import type { FailureOutput } from '../with-error-handling.js';
import { buildInputSchema, initSummary, registerSandboxCommands } from './sandbox.js';

describe('initSummary', () => {
  it('tells the operator to check the starter files without an agent', () => {
    expect(initSummary({ status: 'written' }, configName())).toContain('jig init --no-agent');
  });

  it('passes on what to set when steps have no agent', () => {
    const instruction = faker.lorem.sentence();

    expect(initSummary({ status: 'needs-agents', instruction }, configName())).toContain(
      instruction,
    );
  });

  it('counts the attempts a verified sandbox took only when it took more than one', () => {
    const attempts = faker.number.int({ min: 2, max: 3 });

    expect(initSummary({ status: 'verified', attempts }, configName())).toContain(
      `${attempts} attempts`,
    );
    expect(initSummary({ status: 'verified', attempts: 1 }, configName())).not.toContain('attempt');
  });

  it('shows why the sandbox failed, and how many attempts were spent on it', () => {
    const failure = faker.lorem.paragraph();
    const attempts = faker.number.int({ min: 2, max: 3 });

    const summary = initSummary({ status: 'failed', attempts, failure }, configName());

    expect(summary).toContain(failure);
    expect(summary).toContain(`${attempts} attempts`);
    expect(initSummary({ status: 'failed', attempts: 1, failure }, configName())).not.toContain(
      'attempts',
    );
  });
});

describe('buildInputSchema', () => {
  const logFormat = 'json';

  it('passes on a named preset, asks on a bare --preset, and uses none when it is left out', () => {
    const name = presetName();

    expect(buildInputSchema.parse({ preset: name, logFormat }).preset).toEqual({
      kind: 'named',
      name,
    });
    expect(buildInputSchema.parse({ preset: true, logFormat }).preset).toEqual({ kind: 'ask' });
    expect(buildInputSchema.parse({ logFormat }).preset).toBeUndefined();
  });
});

describe('build --preset', () => {
  it('asks which preset to use on a bare --preset and stops before opening the app when nobody answers', async () => {
    const preset = presetName();
    const { parse, askForPreset, createApp, failureOutput } = await setup({
      builtinPresets: [preset],
    });

    await parse(['build', '--preset', '--log-format', 'json']);

    expect(askForPreset.mock.calls[0]?.[0].map(({ name }: Preset) => name)).toEqual([preset]);
    expect(createApp).not.toHaveBeenCalled();
    expect(failureOutput.setExitCode).toHaveBeenCalledWith(1);
  });

  it('looks up a named preset without asking and stops before opening the app when it is missing', async () => {
    const { parse, askForPreset, createApp, failureOutput } = await setup({
      builtinPresets: [presetName()],
    });

    await parse(['build', '--preset', presetName(), '--log-format', 'json']);

    expect(askForPreset).not.toHaveBeenCalled();
    expect(createApp).not.toHaveBeenCalled();
    expect(failureOutput.setExitCode).toHaveBeenCalledWith(1);
  });

  async function setup(input: { builtinPresets: PresetName[] }) {
    const repo = await createTempRepo();
    const home = await tempDirectory('jig-build-home-');
    const builtinPresetsDirectory = await tempDirectory('jig-build-builtin-');
    for (const name of input.builtinPresets) {
      await writeFile(path.join(builtinPresetsDirectory, `${name}.json`), '{}');
    }
    const askForPreset = vi.fn(async (_presets: Preset[]) => undefined);
    const createApp = vi.fn(createAppContainer);
    const failureOutput = mock<FailureOutput>();
    const program = new Command();
    registerSandboxCommands(program, {
      invocation: {
        cwd: repo.dir,
        environment: { HOME: home },
        fallbackHomeDirectory: home,
        askForPreset,
        createAppContainer: createApp,
        configSourceAt: configFileSource,
        standardInput: fakeStandardInput(),
        presetFiles: presetFilesOnDisk(builtinPresetsDirectory),
      },
      failureOutput,
    });
    const parse = async (argv: string[]) => {
      await program.parseAsync(argv, { from: 'user' });
    };
    return { parse, askForPreset, createApp, failureOutput };
  }
});

function configName() {
  return `${faker.word.noun()}.json`;
}
