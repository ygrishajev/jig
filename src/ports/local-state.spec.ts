import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { LocalPreparationFailed, LocalStateUnwritable } from './local-state.js';

describe('local state failures', () => {
  it('aborts on a file of jig’s own it cannot write, naming the path', () => {
    const path = faker.system.filePath();

    const failure = new LocalStateUnwritable({ message: faker.lorem.sentence(), path });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'LocalStateUnwritable', path });
  });

  it('aborts on a file it prepares a run with that it cannot use', () => {
    const failure = new LocalPreparationFailed({ message: faker.lorem.sentence() });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'LocalPreparationFailed' });
  });
});
