import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { GitCommandFailed, RemoteUnavailable, RepositoryInvalid } from './git-failures.js';

describe('Git failures', () => {
  it.each([
    ['retries an unreachable remote', () => new RemoteUnavailable({ message: message() }), 'retry'],
    [
      'blocks on a failed git command',
      () => new GitCommandFailed({ message: message(), command: message(), output: message() }),
      'block',
    ],
    [
      'aborts in an unusable repository',
      () => new RepositoryInvalid({ message: message() }),
      'fatal',
    ],
  ])('%s', (_case, create, kind) => {
    const failure = create();

    expect(failure.kind).toBe(kind);
    expect(failure._tag).toBe(failure.constructor.name);
  });

  it('keeps the command and what it printed on a failed git command', () => {
    const command = `git ${faker.word.verb()}`;
    const output = faker.lorem.paragraph();

    const failure = new GitCommandFailed({ message: message(), command, output });

    expect(failure).toMatchObject({ command, output });
  });
});

function message() {
  return faker.lorem.sentence();
}
