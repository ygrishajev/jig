import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { CommitImportRefused, CommitRejected, MergeFailed } from './workspace.js';

describe('workspace failures', () => {
  it.each([
    ['blocks on a failed merge', MergeFailed],
    ['blocks on sandbox commits it refuses', CommitImportRefused],
  ])('%s', (_case, Failure) => {
    const failure = new Failure({ message: faker.lorem.sentence() });

    expect(failure.kind).toBe('block');
    expect(failure._tag).toBe(Failure.name);
  });

  it('blocks on a commit the hooks rejected and keeps what they printed', () => {
    const output = faker.lorem.paragraph();

    const failure = new CommitRejected({ message: faker.lorem.sentence(), output });

    expect(failure).toMatchObject({ kind: 'block', _tag: 'CommitRejected', output });
  });
});
