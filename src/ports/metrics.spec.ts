import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { MetricsLogCorrupt } from './metrics.js';

describe('metrics failures', () => {
  it('classifies MetricsLogCorrupt and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new MetricsLogCorrupt({ message });

    expect(error).toMatchObject({
      _tag: 'MetricsLogCorrupt',
      kind: 'fatal',
      message,
    });
  });
});
