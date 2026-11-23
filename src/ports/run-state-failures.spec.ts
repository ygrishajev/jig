import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  RunCodeUnavailable,
  RunInProgress,
  RunStateConflict,
  RunStateInvalid,
  RunStoreFailed,
} from './run-state-failures.js';

describe('run-state-failures failures', () => {
  it('classifies RunStateConflict and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RunStateConflict({ message });

    expect(error).toMatchObject({
      _tag: 'RunStateConflict',
      kind: 'block',
      message,
    });
  });

  it('classifies RunCodeUnavailable and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RunCodeUnavailable({ message });

    expect(error).toMatchObject({
      _tag: 'RunCodeUnavailable',
      kind: 'block',
      message,
    });
  });

  it('classifies RunInProgress and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RunInProgress({ message });

    expect(error).toMatchObject({
      _tag: 'RunInProgress',
      kind: 'fatal',
      message,
    });
  });

  it('classifies RunStateInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RunStateInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });

  it('classifies RunStoreFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new RunStoreFailed({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });
});
