import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { latestAgentVersions, type RegistryLookup } from './latest-agent-versions.js';

describe('latestAgentVersions', () => {
  it('maps each package to the latest version the registry gives', async () => {
    const versions = {
      [packageName()]: faker.system.semver(),
      [packageName()]: faker.system.semver(),
    };

    const latest = await latestAgentVersions(Object.keys(versions), async (name) => versions[name]);

    expect(latest).toEqual(versions);
  });

  it('leaves a package the registry failed on without a version, keeping the others', async () => {
    const answered = packageName();
    const failed = packageName();
    const version = faker.system.semver();
    const lookup: RegistryLookup = async (name) => {
      if (name === failed) throw new Error(faker.lorem.sentence());
      return version;
    };

    expect(await latestAgentVersions([answered, failed], lookup)).toEqual({
      [answered]: version,
      [failed]: undefined,
    });
  });

  it('stops waiting for a registry that does not answer in time', async () => {
    const slow = packageName();
    const hangs: RegistryLookup = () => new Promise(() => {});

    expect(await latestAgentVersions([slow], hangs, 5)).toEqual({ [slow]: undefined });
  });
});

function packageName() {
  return `@${faker.word.noun()}/${faker.string.alphanumeric({ length: 8, casing: 'lower' })}`;
}
