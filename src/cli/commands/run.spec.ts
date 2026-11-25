import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aRunState, aSlice, presetName, runId } from '../../../tests/support/builders.js';
import { fakeStandardInput } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { type JigOperations, type RunReport, RunRequestInvalid } from '../../app/api.js';
import { runBranchFor, runStopReason } from '../../domain/run-state.js';
import type { StandardInput } from '../../ports/request-inputs.js';
import type { OutcomeLog } from '../command-io.js';
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

describe('run command', () => {
  it('starts the run a request file describes, with the options it was given', async () => {
    const text = faker.lorem.paragraph();
    const { parse, run, writeRequest } = setup();
    const file = await writeRequest(text);
    const id = runId();
    const config = `${faker.word.noun()}.json`;
    const preset = presetName();

    await parse([file, '--id', id, '--no-merge', '--config', config, '--preset', preset]);

    expect(run).toHaveBeenCalledWith({
      run: { start: { text, file, merge: false }, runId: id },
      configPath: config,
      preset: { kind: 'named', name: preset },
      logFormat: 'json',
    });
  });

  it('resumes the run an id names and tells the operator what to do next', async () => {
    const state = aRunState({ phase: 'done' });
    const { parse, run, outcomeLog, output } = setup({ report: { state, status: 'done' } });

    await parse(['--id', state.runId]);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ run: { resume: state.runId } }));
    expect(outcomeLog.info).toHaveBeenCalledWith(
      { runId: state.runId, branch: runBranchFor(state.runId) },
      nextStep({ state, status: 'done' }),
    );
    expect(output.setExitCode).not.toHaveBeenCalled();
  });

  it('asks the operation for a preset on a bare --preset', async () => {
    const { parse, run } = setup();

    await parse(['--id', runId(), '--preset']);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ preset: { kind: 'ask' } }));
  });

  it("prints the operation's failure and exits with 1", async () => {
    const failure = new RunRequestInvalid({ message: faker.lorem.sentence() });
    const { parse, output, outcomeLog } = setup({ failure });

    await parse(['--id', runId()]);

    expect(output.printError).toHaveBeenCalledWith(failure.message);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
    expect(outcomeLog.info).not.toHaveBeenCalled();
  });

  it('refuses input that names neither a request nor a run without asking for one', async () => {
    const { parse, run, output } = setup();

    await parse([]);

    expect(run).not.toHaveBeenCalled();
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  it('refuses a terminal on standard input without reading it or asking for a run', async () => {
    const standardInput = fakeStandardInput({ isTerminal: true });
    const { parse, run, output } = setup({ standardInput });

    await parse(['-']);

    expect(standardInput.readAll).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  it('refuses blank piped text without asking for a run', async () => {
    const { parse, run, output } = setup({
      standardInput: fakeStandardInput({ text: ' \n\t\n' }),
    });

    await parse(['-']);

    expect(run).not.toHaveBeenCalled();
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  it('refuses a request file it cannot read without asking for a run', async () => {
    const { parse, run, output } = setup();

    await parse([`${faker.string.uuid()}.md`]);

    expect(run).not.toHaveBeenCalled();
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  function setup(
    input: {
      report?: RunReport;
      failure?: RunRequestInvalid;
      standardInput?: StandardInput;
    } = {},
  ) {
    const report = input.report ?? { state: aRunState(), status: 'done' as const };
    const run = vi.fn<JigOperations['run']>(async () =>
      input.failure ? Result.err(input.failure) : Result.ok(report),
    );
    const outcomeLog = mock<OutcomeLog>();
    const output = mock<FailureOutput>();
    const directory = tempDirectory('jig-run-request-');
    const standardInput = input.standardInput ?? fakeStandardInput();
    const program = new Command();
    registerRunCommand(
      program,
      run,
      {
        requestInputs: {
          cwd: () => process.cwd(),
          standardInput: () => standardInput,
          readTextFile: (file) => readFile(file, 'utf-8'),
        },
        outcomeLog: () => outcomeLog,
        defaultLogFormat: 'json',
      },
      output,
    );
    return {
      run,
      outcomeLog,
      output,
      parse: async (argv: string[]) => {
        await program.parseAsync(['run', ...argv, '--log-format', 'json'], { from: 'user' });
      },
      writeRequest: async (text: string) => {
        const file = path.join(await directory, `${faker.string.uuid()}.md`);
        await writeFile(file, text);
        return file;
      },
    };
  }
});
