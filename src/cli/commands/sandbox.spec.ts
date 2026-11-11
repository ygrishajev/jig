import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { presetName } from '../../../tests/support/builders.js';
import { CONFIG_FILE } from '../../config/load-config.js';
import { buildInputSchema, initSummary } from './sandbox.js';

describe('initSummary', () => {
  it('tells the operator to check the starter files without an agent', () => {
    expect(initSummary({ status: 'written' }, CONFIG_FILE)).toContain('jig init --no-agent');
  });

  it('passes on what to set when steps have no agent', () => {
    const instruction = faker.lorem.sentence();

    expect(initSummary({ status: 'needs-agents', instruction }, CONFIG_FILE)).toContain(
      instruction,
    );
  });

  it('counts the attempts a verified sandbox took only when it took more than one', () => {
    const attempts = faker.number.int({ min: 2, max: 3 });

    expect(initSummary({ status: 'verified', attempts }, CONFIG_FILE)).toContain(
      `${attempts} attempts`,
    );
    expect(initSummary({ status: 'verified', attempts: 1 }, CONFIG_FILE)).not.toContain('attempt');
  });

  it('shows why the sandbox failed, and how many attempts were spent on it', () => {
    const failure = faker.lorem.paragraph();
    const attempts = faker.number.int({ min: 2, max: 3 });

    const summary = initSummary({ status: 'failed', attempts, failure }, CONFIG_FILE);

    expect(summary).toContain(failure);
    expect(summary).toContain(`${attempts} attempts`);
    expect(initSummary({ status: 'failed', attempts: 1, failure }, CONFIG_FILE)).not.toContain(
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
