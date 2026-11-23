import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  ImageBuildFailed,
  ImageRecipeInvalid,
  SandboxPreparationFailed,
  SandboxUnavailable,
  SetupCommandFailed,
} from './sandbox.js';

describe('sandbox failures', () => {
  it('classifies SandboxUnavailable and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new SandboxUnavailable({ message });

    expect(error).toMatchObject({
      _tag: 'SandboxUnavailable',
      kind: 'retry',
      message,
    });
  });

  it('classifies SetupCommandFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();
    const output = faker.lorem.sentence();

    const error = new SetupCommandFailed({ message, output });

    expect(error).toMatchObject({
      _tag: 'SetupCommandFailed',
      kind: 'retry',
      message,
      output,
    });
  });

  it('classifies ImageBuildFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();
    const output = faker.lorem.sentence();

    const error = new ImageBuildFailed({ message, output });

    expect(error).toMatchObject({
      _tag: 'ImageBuildFailed',
      kind: 'fatal',
      message,
      output,
    });
  });

  it('classifies SandboxPreparationFailed and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new SandboxPreparationFailed({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });

  it('classifies ImageRecipeInvalid and preserves its payload', () => {
    const message = faker.lorem.sentence();

    const error = new ImageRecipeInvalid({ message });

    expect(error).toMatchObject({
      _tag: 'ConfigInvalid',
      kind: 'fatal',
      message,
    });
  });
});
