import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { GitCommandFailed, RemoteUnavailable, RepositoryInvalid } from './git-failures.js';

describe('git-failures failures', () => {
  it('classifies RemoteUnavailable and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RemoteUnavailable({ message });

    expect(error).toMatchObject({
      _tag: 'RemoteUnavailable',
      kind: 'retry',
      message,
    });
  });

  it('classifies GitCommandFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();
    const output = faker.lorem.sentence();
    const command = faker.lorem.sentence();

    const error = new GitCommandFailed({ message, output, command });

    expect(error).toMatchObject({
      _tag: 'GitCommandFailed',
      kind: 'block',
      message,
      output,
      command,
    });
  });

  it('classifies RepositoryInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RepositoryInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });
});
