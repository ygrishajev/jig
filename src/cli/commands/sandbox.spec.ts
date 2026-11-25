import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { presetName } from '../../../tests/support/builders.js';
import { LocalPreparationFailed } from '../../ports/local-state.js';
import { ImageBuildFailed } from '../../ports/sandbox-images.js';
import type { OutcomeLog } from '../command-io.js';
import type { FailureOutput } from '../with-error-handling.js';
import {
  buildInputSchema,
  initSummary,
  registerSandboxCommands,
  type SandboxOperations,
} from './sandbox.js';

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

describe('sandbox commands', () => {
  it('asks init for the agent and the config file it was given, and prints its summary', async () => {
    const configPath = `${faker.word.noun()}.json`;
    const { parse, init, outcomeLog, output } = setup({
      initialized: Result.ok({ outcome: { status: 'written' }, configName: configPath }),
    });

    await parse(['init', '--no-agent', '--config', configPath, '--log-format', 'json']);

    expect(init).toHaveBeenCalledWith({ useAgent: false, configPath, logFormat: 'json' });
    expect(outcomeLog.info).toHaveBeenCalledWith(
      { status: 'written' },
      initSummary({ status: 'written' }, configPath),
    );
    expect(output.setExitCode).not.toHaveBeenCalled();
  });

  it('exits with 1 when setup or verify did not pass in the sandbox', async () => {
    const { parse, output } = setup({
      initialized: Result.ok({
        outcome: { status: 'failed', attempts: 1, failure: faker.lorem.sentence() },
        configName: configName(),
      }),
    });

    await parse(['init']);

    expect(output.setExitCode).toHaveBeenCalledWith(1);
    expect(output.printError).not.toHaveBeenCalled();
  });

  it("prints init's failure and exits with 1 without a summary", async () => {
    const failure = new LocalPreparationFailed({ message: faker.lorem.sentence() });
    const { parse, outcomeLog, output } = setup({ initialized: Result.err(failure) });

    await parse(['init']);

    expect(output.printError).toHaveBeenCalledWith(failure.message);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
    expect(outcomeLog.info).not.toHaveBeenCalled();
  });

  it('asks build for the preset, config and agent updates it was given, and names the image', async () => {
    const image = `${faker.word.noun()}:${faker.system.semver()}`;
    const configPath = `${faker.word.noun()}.json`;
    const preset = presetName();
    const { parse, buildImage, outcomeLog } = setup({ built: Result.ok({ image }) });

    await parse([
      'build',
      '--pull-agents',
      '--preset',
      preset,
      '--config',
      configPath,
      '--log-format',
      'json',
    ]);

    expect(buildImage).toHaveBeenCalledWith({
      pullAgents: true,
      configPath,
      preset: { kind: 'named', name: preset },
      logFormat: 'json',
    });
    expect(outcomeLog.info).toHaveBeenCalledWith({ image }, expect.stringContaining(image));
  });

  it("prints build's failure and exits with 1", async () => {
    const failure = new ImageBuildFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.paragraph(),
    });
    const { parse, output } = setup({ built: Result.err(failure) });

    await parse(['build']);

    expect(output.printError).toHaveBeenCalledWith(failure.message);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  function setup(input: {
    initialized?: Awaited<ReturnType<SandboxOperations['init']>>;
    built?: Awaited<ReturnType<SandboxOperations['buildImage']>>;
  }) {
    const init = vi.fn<SandboxOperations['init']>(
      async () =>
        input.initialized ??
        Result.ok({ outcome: { status: 'written' }, configName: configName() }),
    );
    const buildImage = vi.fn<SandboxOperations['buildImage']>(
      async () => input.built ?? Result.ok({ image: faker.word.noun() }),
    );
    const outcomeLog = mock<OutcomeLog>();
    const output = mock<FailureOutput>();
    const program = new Command();
    registerSandboxCommands(
      program,
      { init, buildImage },
      { outcomeLog: () => outcomeLog, defaultLogFormat: 'json' },
      output,
    );
    return {
      init,
      buildImage,
      outcomeLog,
      output,
      parse: (argv: string[]) => program.parseAsync(argv, { from: 'user' }),
    };
  }
});

function configName() {
  return `${faker.word.noun()}.json`;
}
