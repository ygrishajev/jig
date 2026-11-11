import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aPreset } from '../../../tests/support/builders.js';
import { describePresets } from './presets.js';

describe('describePresets', () => {
  it('lists each preset with where it was read from, and its description when it has one', () => {
    const described = aPreset({ description: faker.lorem.sentence() });
    const bare = aPreset();

    const lines = describePresets([described, bare]).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^${described.name}\\s+${described.source}\\s+`));
    expect(lines[0]?.endsWith(described.path)).toBe(true);
    expect(lines[1]?.trim()).toBe(described.description);
    expect(lines[2]).toMatch(new RegExp(`^${bare.name}\\s+${bare.source}\\s+`));
    expect(lines[2]?.endsWith(bare.path)).toBe(true);
  });

  it('says there are none rather than printing nothing', () => {
    expect(describePresets([])).not.toBe('');
  });
});
