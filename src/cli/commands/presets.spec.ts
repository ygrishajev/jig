import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aPreset } from '../../../tests/support/builders.js';
import type { JigOperations } from '../../app/api.js';
import { ConfigInvalid } from '../../config/errors.js';
import type { FailureOutput } from '../with-error-handling.js';
import { describePresets, registerPresetsCommand } from './presets.js';

describe('presets command handler', () => {
  it("prints the listing's failure and exits with 1", async () => {
    const failure = new ConfigInvalid({ message: faker.lorem.sentence() });
    const listPresets = vi.fn<JigOperations['listPresets']>(async () => Result.err(failure));
    const output = mock<FailureOutput>();
    const program = new Command();
    registerPresetsCommand(program, listPresets, output);

    await program.parseAsync(['presets'], { from: 'user' });

    expect(listPresets).toHaveBeenCalledOnce();
    expect(output.printError).toHaveBeenCalledWith(failure.message);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });
});

describe('describePresets', () => {
  it('lists each preset with where it was read from, and its description when it has one', () => {
    const described = aPreset({ description: faker.lorem.sentence() });
    const bare = aPreset();

    const lines = describePresets([described, bare]).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^${described.name}\\s+${described.label.source}\\s+`));
    expect(lines[0]?.endsWith(described.label.location)).toBe(true);
    expect(lines[1]?.trim()).toBe(described.description);
    expect(lines[2]).toMatch(new RegExp(`^${bare.name}\\s+${bare.label.source}\\s+`));
    expect(lines[2]?.endsWith(bare.label.location)).toBe(true);
  });

  it('says there are none rather than printing nothing', () => {
    expect(describePresets([])).not.toBe('');
  });
});
