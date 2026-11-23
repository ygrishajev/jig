import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { FilesystemPreparationFailed, LocalStateUnwritable } from './filesystem.js';

describe('filesystem failures', () => {
  it('classifies LocalStateUnwritable and preserves its payload', () => {
    const message = faker.lorem.sentence();
    const path = faker.lorem.sentence();

    const error = new LocalStateUnwritable({ message, path });

    expect(error).toMatchObject({
      _tag: 'LocalStateUnwritable',
      kind: 'fatal',
      message,
      path,
    });
  });

  it('classifies FilesystemPreparationFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new FilesystemPreparationFailed({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });
});
