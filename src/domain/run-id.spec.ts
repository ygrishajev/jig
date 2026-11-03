import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import { runIdSchema } from './run-id.js';

describe('runIdSchema', () => {
  it('accepts an id made of lowercase letters, digits and hyphens', () => {
    const id = `${runId()}-${faker.number.int({ min: 0, max: 99 })}`;

    expect(runIdSchema.parse(id)).toBe(id);
  });

  it.each(['../x', 'a/b', 'Upper', 'two words', ''])('refuses "%s"', (raw) => {
    expect(runIdSchema.safeParse(raw).success).toBe(false);
  });
});
