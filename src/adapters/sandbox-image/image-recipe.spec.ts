import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import {
  agentLayerDockerfile,
  BASE_DOCKERFILE,
  formatAgentVersions,
  parseAgentVersions,
  recipeHash,
  TOOLCHAIN_END,
  TOOLCHAIN_START,
  withToolchain,
} from './image-recipe.js';

describe('image recipe', () => {
  it("puts the project's toolchain between the markers and leaves the rest alone", () => {
    const toolchain = `RUN apt-get install -y ${faker.word.noun()}`;

    const filled = withToolchain(BASE_DOCKERFILE, toolchain);

    expect(filled).toContain(`${TOOLCHAIN_START}\n${toolchain}\n${TOOLCHAIN_END}`);
    expect(filled.replace(`${toolchain}\n`, '')).toBe(BASE_DOCKERFILE);
  });

  it('replaces an earlier toolchain instead of appending to it', () => {
    const first = `RUN echo ${faker.word.noun()}`;
    const second = `RUN echo ${faker.word.noun()}`;

    const filled = withToolchain(withToolchain(BASE_DOCKERFILE, first), second);

    expect(filled).toContain(second);
    expect(filled).not.toContain(first);
  });

  it('refuses a Dockerfile without the toolchain markers', () => {
    expect(() => withToolchain('FROM node:22', 'RUN true')).toThrow('no "');
  });

  it('installs each agent at its exact version on top of the base image', () => {
    const base = `sandcastle:${faker.word.noun()}-base`;
    const version = faker.system.semver();

    const layer = agentLayerDockerfile(base, [
      { name: 'claude', npmPackage: '@anthropic-ai/claude-code', version },
    ]);

    expect(layer.split('\n')[0]).toBe(`FROM ${base}`);
    expect(layer).toContain(`@anthropic-ai/claude-code@${version}`);
  });

  it('reads back the agent versions it wrote into the label', () => {
    const agents = [
      { name: 'opencode', npmPackage: 'opencode-ai', version: faker.system.semver() },
      { name: 'claude', npmPackage: '@anthropic-ai/claude-code', version: faker.system.semver() },
    ];

    expect(parseAgentVersions(formatAgentVersions(agents))).toEqual({
      claude: agents[1].version,
      opencode: agents[0].version,
    });
  });

  it('gives a different hash when the Dockerfile or the user it is built for changes', () => {
    const hash = recipeHash(BASE_DOCKERFILE, 501, 20);

    expect(recipeHash(BASE_DOCKERFILE, 501, 20)).toBe(hash);
    expect(recipeHash(`${BASE_DOCKERFILE}\n`, 501, 20)).not.toBe(hash);
    expect(recipeHash(BASE_DOCKERFILE, 1001, 20)).not.toBe(hash);
  });
});
