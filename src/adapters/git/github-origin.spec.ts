import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { githubNameIn } from './github-origin.js';

describe('githubNameIn', () => {
  it.each([
    (name: string) => `https://github.com/${name}.git`,
    (name: string) => `git@github.com:${name}.git`,
    (name: string) => `ssh://git@github.com/${name}.git`,
    (name: string) => `https://github.com/${name}/`,
  ])('reads the repository a GitHub remote names: %s', (urlOf) => {
    const name = `${faker.string.alpha(10)}/${faker.string.alpha(10)}`;

    expect(githubNameIn(urlOf(name))).toBe(name);
  });

  it('names nothing for a remote outside GitHub', () => {
    const url = `https://${faker.internet.domainName()}/${faker.string.alpha(10)}/${faker.string.alpha(10)}.git`;

    expect(githubNameIn(url)).toBeUndefined();
  });
});
