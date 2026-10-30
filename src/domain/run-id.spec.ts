import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import { RunRequestInvalid } from './errors.js';
import { parseRunId } from './run-id.js';

describe('parseRunId', () => {
  it('accepts an id made of lowercase letters, digits and hyphens', () => {
    const id = `${runId()}-${faker.number.int({ min: 0, max: 99 })}`;

    expect(parseRunId(id)).toBe(id);
  });

  it.each(['../x', 'a/b', 'Upper', 'two words', ''])('refuses "%s"', (raw) => {
    expect(() => parseRunId(raw)).toThrow(RunRequestInvalid);
  });
});
