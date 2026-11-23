import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { CommitImportRefused, CommitRejected, MergeFailed } from './workspace.js';

describe('workspace failures', () => {
  it('classifies MergeFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new MergeFailed({ message });

    expect(error).toMatchObject({
      _tag: 'MergeFailed',
      kind: 'block',
      message,
    });
  });

  it('classifies CommitImportRefused and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new CommitImportRefused({ message });

    expect(error).toMatchObject({
      _tag: 'CommitImportRefused',
      kind: 'block',
      message,
    });
  });

  it('classifies CommitRejected and preserves its payload', () => {
    const message = faker.lorem.sentence();
    const output = faker.lorem.sentence();

    const error = new CommitRejected({ message, output });

    expect(error).toMatchObject({
      _tag: 'CommitRejected',
      kind: 'block',
      message,
      output,
    });
  });
});
