import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ConfigInvalid } from '../../domain/errors.js';
import {
  agentLayerDockerfile,
  BASE_DOCKERFILE,
  formatAgentVersions,
  imageLabels,
  LABELS,
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

  it('refuses a Dockerfile without both toolchain markers in order', () => {
    const toolchain = `RUN ${faker.word.verb()}`;

    for (const dockerfile of [
      `FROM node:22`,
      `FROM node:22\n${TOOLCHAIN_START}\n`,
      `FROM node:22\n${TOOLCHAIN_END}\n`,
      `FROM node:22\n${TOOLCHAIN_END}\n${TOOLCHAIN_START}\n`,
    ]) {
      expect(() => withToolchain(dockerfile, toolchain)).toThrow(ConfigInvalid);
    }
  });

  it('trims the toolchain, and leaves the markers adjacent for an empty one', () => {
    const toolchain = `RUN ${faker.word.verb()}`;

    expect(withToolchain(BASE_DOCKERFILE, `\n  ${toolchain}  \n`)).toContain(
      `${TOOLCHAIN_START}\n${toolchain}\n${TOOLCHAIN_END}`,
    );
    expect(withToolchain(BASE_DOCKERFILE, '  \n')).toBe(BASE_DOCKERFILE);
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

  it('installs every agent in one npm install', () => {
    const agents = someAgents();

    const install = agentLayerDockerfile(faker.word.noun(), agents)
      .split('\n')
      .find((line) => line.includes('npm install'));

    expect(install).toContain(
      agents.map((agent) => `${agent.npmPackage}@${agent.version}`).join(' '),
    );
  });

  it('labels the image the same whatever order the agents come in', () => {
    const agents = someAgents();
    const hash = faker.string.hexadecimal({ length: 16, casing: 'lower', prefix: '' });

    const labels = imageLabels(hash, agents);

    expect(imageLabels(hash, [...agents].reverse())).toEqual(labels);
    expect(labels).toEqual({
      [LABELS.dockerfileHash]: hash,
      [LABELS.agents]: 'claude,opencode',
      [LABELS.agentVersions]: `claude=${agents[1].version},opencode=${agents[0].version}`,
    });
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

  it('ignores an agent-versions entry without a name or a version', () => {
    const version = faker.system.semver();
    const label = [
      `claude=${version}`,
      faker.word.noun(),
      `${faker.word.noun()}=`,
      `=${faker.system.semver()}`,
    ].join(',');

    expect(parseAgentVersions(label)).toStrictEqual({ claude: version });
    expect(parseAgentVersions(undefined)).toStrictEqual({});
  });

  it('gives a different hash when the Dockerfile or the user it is built for changes', () => {
    const hash = recipeHash(BASE_DOCKERFILE, 501, 20);

    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(recipeHash(BASE_DOCKERFILE, 501, 20)).toBe(hash);
    expect(recipeHash(`${BASE_DOCKERFILE}\n`, 501, 20)).not.toBe(hash);
    expect(recipeHash(BASE_DOCKERFILE, 1001, 20)).not.toBe(hash);
  });
});

function someAgents() {
  return [
    { name: 'opencode', npmPackage: 'opencode-ai', version: faker.system.semver() },
    { name: 'claude', npmPackage: '@anthropic-ai/claude-code', version: faker.system.semver() },
  ];
}
