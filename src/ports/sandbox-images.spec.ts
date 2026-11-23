import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ImageBuildFailed } from './sandbox-images.js';

describe('ImageBuildFailed', () => {
  it('aborts on an image that could not be built and keeps what docker said', () => {
    const output = faker.lorem.paragraph();

    const failure = new ImageBuildFailed({ message: faker.lorem.sentence(), output });

    expect(failure).toMatchObject({ kind: 'fatal', _tag: 'ImageBuildFailed', output });
  });
});
