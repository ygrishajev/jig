import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import type { ImageBuildSpec } from '../../ports/sandbox-images.js';
import { dockerBuildArguments } from './docker-images.js';

describe('dockerBuildArguments', () => {
  it('passes every build arg and label as its own flag', () => {
    const uid = faker.number.int({ min: 1000, max: 60000 });
    const label = faker.word.noun();
    const value = faker.string.alphanumeric(12);
    const { spec } = setup({
      buildArgs: { AGENT_UID: uid },
      labels: { [label]: value },
    });

    const args = dockerBuildArguments(spec);

    expect(flagValues(args, '--build-arg')).toEqual([`AGENT_UID=${uid}`]);
    expect(flagValues(args, '--label')).toEqual([`${label}=${value}`]);
  });

  it('tags the image it builds', () => {
    const { spec } = setup({});

    expect(flagValues(dockerBuildArguments(spec), '-t')).toEqual([spec.tag]);
  });

  it('builds from the context directory when there is no Dockerfile text', () => {
    const contextDirectory = faker.system.directoryPath();
    const { spec } = setup({ contextDirectory });

    expect(dockerBuildArguments(spec).at(-1)).toBe(contextDirectory);
  });

  it('reads the Dockerfile from stdin when it is given as text', () => {
    const { spec } = setup({
      contextDirectory: faker.system.directoryPath(),
      dockerfile: faker.lorem.lines(2),
    });

    expect(dockerBuildArguments(spec).at(-1)).toBe('-');
  });

  it('uses plain docker build without a shared cache', () => {
    const { spec } = setup({});

    expect(dockerBuildArguments(spec).slice(0, 1)).toEqual(['build']);
  });

  it('builds with buildx through a cache scoped to the tag when the cache is gha', () => {
    const { spec } = setup({ tag: `sandcastle:${faker.word.noun()}` });

    const args = dockerBuildArguments(spec, 'gha');
    const scope = spec.tag.replace(':', '-');

    expect(args.slice(0, 3)).toEqual(['buildx', 'build', '--load']);
    expect(flagValues(args, '--cache-from')).toEqual([`type=gha,scope=${scope}`]);
    expect(flagValues(args, '--cache-to')).toEqual([`type=gha,mode=max,scope=${scope}`]);
  });

  function setup(input: Partial<ImageBuildSpec>) {
    const spec: ImageBuildSpec = {
      tag: faker.word.noun(),
      buildArgs: {},
      ...input,
    };
    return { spec };
  }
});

function flagValues(args: string[], flag: string) {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));
}
