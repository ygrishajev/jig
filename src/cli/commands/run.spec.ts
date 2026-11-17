import { faker } from '@faker-js/faker';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aRunState, aSlice, presetName, runId } from '../../../tests/support/builders.js';
import { fakeStandardInput } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import type { StandardInput } from '../../adapters/terminal/standard-input.js';
import { createAppContainer } from '../../app/container.js';
import type { Preset, PresetName } from '../../config/presets.js';
import { runBranchFor, runStopReason } from '../../domain/run-state.js';
import type { FailureOutput } from '../with-error-handling.js';
import { nextStep, registerRunCommand, runInputSchema } from './run.js';

describe('nextStep', () => {
  it('asks for nothing more once the run is done', () => {
    const state = aRunState({ phase: 'done' });

    expect(nextStep({ state, status: 'done' })).not.toContain(state.runId);
  });

  it('names the run branch to review once a run finished without merging', () => {
    const state = aRunState({ phase: 'completed', merge: false });

    const step = nextStep({ state, status: 'completed' });

    expect(step).toContain(runBranchFor(state.runId));
    expect(step).not.toBe(nextStep({ state, status: 'done' }));
  });

  it('asks for the design to be read before resuming a run paused after planning', () => {
    const state = aRunState({ phase: 'paused' });

    const step = nextStep({ state, status: 'halted' });

    expect(step).toContain(`jig run --id ${state.runId}`);
    expect(step).not.toContain(runBranchFor(state.runId));
  });

  it('names the branch to merge before resuming a run waiting to be merged', () => {
    const state = aRunState({ phase: 'awaitingMerge' });

    const step = nextStep({ state, status: 'halted' });

    expect(step).toContain(runBranchFor(state.runId));
    expect(step).toContain(`jig run --id ${state.runId}`);
  });

  it('gives the reason a blocked run stopped and how to resume it', () => {
    const reason = faker.lorem.sentence();
    const state = aRunState({ phase: 'merging', blockedReason: reason });

    const step = nextStep({ state, status: 'blocked', reason });

    expect(step).toContain(reason);
    expect(step).toContain(`jig run --id ${state.runId}`);
  });

  it.each(['hookFailures', 'verificationFailures'] as const)(
    'reports an exhausted %s budget and points to its feedback',
    (counter) => {
      const state = aRunState({
        phase: 'stuck',
        slices: [aSlice({ status: 'stuck', [counter]: 3 })],
      });

      const step = nextStep({ state, status: 'stuck' });

      expect(step).toContain(runStopReason(state));
      expect(step).toContain(`jig status ${state.runId}`);
    },
  );

  it('names the stuck slice and its branch, and points to status rather than a resume', () => {
    const stuck = aSlice({ status: 'stuck' });
    const state = aRunState({ phase: 'stuck', slices: [aSlice({ status: 'approved' }), stuck] });

    const step = nextStep({ state, status: 'stuck' });

    expect(step).toContain(stuck.id);
    expect(step).toContain(runBranchFor(state.runId));
    expect(step).toContain(`jig status ${state.runId}`);
    expect(step).not.toContain('jig run --id');
  });
});

describe('runInputSchema', () => {
  const logFormat = 'json';

  it('starts a run from a request, named by the id when one is given', () => {
    const request = faker.system.filePath();
    const id = runId();

    expect(runInputSchema.parse({ request, logFormat }).run).toEqual({
      start: { file: request },
      merge: true,
    });
    expect(runInputSchema.parse({ request, id, logFormat }).run).toEqual({
      start: { file: request },
      runId: id,
      merge: true,
    });
  });

  it('starts a run that skips the merge when --no-merge is given', () => {
    const request = faker.system.filePath();

    expect(runInputSchema.parse({ request, merge: false, logFormat }).run).toMatchObject({
      merge: false,
    });
  });

  it('reads the request from standard input when the request is -', () => {
    expect(runInputSchema.parse({ request: '-', logFormat }).run).toEqual({
      start: { stdin: true },
      merge: true,
    });
  });

  it('resumes the run named by an id given alone', () => {
    const id = runId();

    expect(runInputSchema.parse({ id, logFormat }).run).toEqual({ resume: id });
  });

  it('refuses neither a request nor an id, and an id that is not a valid run id', () => {
    expect(runInputSchema.safeParse({ logFormat }).success).toBe(false);
    expect(runInputSchema.safeParse({ id: '../x', logFormat }).success).toBe(false);
    expect(
      runInputSchema.safeParse({ request: faker.system.filePath(), id: '../x', logFormat }).success,
    ).toBe(false);
  });

  it('passes on the preset it was asked for and refuses a name that could leave the presets directory', () => {
    const request = faker.system.filePath();
    const name = presetName();

    expect(runInputSchema.parse({ request, preset: name, logFormat }).preset).toEqual({
      kind: 'named',
      name,
    });
    expect(runInputSchema.safeParse({ request, preset: '../x', logFormat }).success).toBe(false);
  });

  it('asks for a preset on a bare --preset and uses none when it is left out', () => {
    const request = faker.system.filePath();

    expect(runInputSchema.parse({ request, preset: true, logFormat }).preset).toEqual({
      kind: 'ask',
    });
    expect(runInputSchema.parse({ request, logFormat }).preset).toBeUndefined();
  });
});

describe('run -', () => {
  it('refuses a terminal before opening the app', async () => {
    const standardInput = fakeStandardInput({ isTerminal: true });
    const { parse, createApp, failureOutput } = await setup({ standardInput });

    await parse(['run', '-', '--log-format', 'json']);

    expect(standardInput.readAll).not.toHaveBeenCalled();
    expect(createApp).not.toHaveBeenCalled();
    expect(failureOutput.setExitCode).toHaveBeenCalledWith(1);
  });

  it('refuses blank piped text before opening the app', async () => {
    const standardInput = fakeStandardInput({ text: ' \n\t\n' });
    const { parse, createApp, failureOutput } = await setup({ standardInput });

    await parse(['run', '-', '--log-format', 'json']);

    expect(createApp).not.toHaveBeenCalled();
    expect(failureOutput.setExitCode).toHaveBeenCalledWith(1);
  });

  async function setup(input: { standardInput: StandardInput }) {
    const repo = await createTempRepo();
    const home = await tempDirectory('jig-run-home-');
    const createApp = vi.fn(createAppContainer);
    const failureOutput = mock<FailureOutput>();
    const program = new Command();
    registerRunCommand(program, {
      invocation: {
        cwd: repo.dir,
        environment: { HOME: home },
        askForPreset: vi.fn(async (_presets: Preset[]) => undefined),
        createAppContainer: createApp,
        standardInput: input.standardInput,
      },
      failureOutput,
    });
    const parse = async (argv: string[]) => {
      await program.parseAsync(argv, { from: 'user' });
    };
    return { parse, createApp, failureOutput };
  }
});

describe('run --preset', () => {
  it('asks which preset to use on a bare --preset and stops before opening the app when nobody answers', async () => {
    const preset = presetName();
    const { parse, request, askForPreset, createApp, failureOutput } = await setup({
      builtinPresets: [preset],
    });

    await parse(['run', request, '--preset', '--log-format', 'json']);

    expect(askForPreset.mock.calls[0]?.[0].map(({ name }: Preset) => name)).toEqual([preset]);
    expect(createApp).not.toHaveBeenCalled();
    expect(failureOutput.setExitCode).toHaveBeenCalledWith(1);
  });

  it('looks up a named preset without asking and stops before opening the app when it is missing', async () => {
    const { parse, request, askForPreset, createApp, failureOutput } = await setup({
      builtinPresets: [presetName()],
    });

    await parse(['run', request, '--preset', presetName(), '--log-format', 'json']);

    expect(askForPreset).not.toHaveBeenCalled();
    expect(createApp).not.toHaveBeenCalled();
    expect(failureOutput.setExitCode).toHaveBeenCalledWith(1);
  });

  async function setup(input: { builtinPresets: PresetName[] }) {
    const repo = await createTempRepo();
    const request = path.join(repo.dir, 'request.md');
    await writeFile(request, faker.lorem.paragraph());
    const home = await tempDirectory('jig-run-home-');
    const builtinPresetsDirectory = await tempDirectory('jig-run-builtin-');
    for (const name of input.builtinPresets) {
      await writeFile(path.join(builtinPresetsDirectory, `${name}.json`), '{}');
    }
    const askForPreset = vi.fn(async (_presets: Preset[]) => undefined);
    const createApp = vi.fn(createAppContainer);
    const failureOutput = mock<FailureOutput>();
    const program = new Command();
    registerRunCommand(program, {
      invocation: {
        cwd: repo.dir,
        environment: { HOME: home },
        askForPreset,
        createAppContainer: createApp,
        standardInput: fakeStandardInput(),
        builtinPresetsDirectory,
      },
      failureOutput,
    });
    const parse = async (argv: string[]) => {
      await program.parseAsync(argv, { from: 'user' });
    };
    return { parse, request, askForPreset, createApp, failureOutput };
  }
});
