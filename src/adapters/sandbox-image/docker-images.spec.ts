import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ImageBuildFailed } from '../../domain/errors.js';
import type { ImageBuildSpec } from '../../ports/sandbox-images.js';
import { classifyInspect, dockerBuildArguments } from './docker-images.js';

describe('classifyInspect', () => {
  it("reads the image's labels from a successful inspect", () => {
    const labels = { [faker.word.noun()]: faker.string.alphanumeric(8) };

    const result = classifyInspect(faker.word.noun(), {
      exitCode: 0,
      stdout: JSON.stringify(labels),
    });

    expect(result.unwrap()).toEqual(labels);
  });

  it('reads an image built without labels as having none', () => {
    expect(classifyInspect(faker.word.noun(), { exitCode: 0, stdout: 'null' }).unwrap()).toEqual(
      {},
    );
  });

  it('reports exit-zero output that is not JSON as unreadable labels', () => {
    const image = faker.word.noun();
    const stdout = `${faker.lorem.word()} {`;

    const result = classifyInspect(image, { exitCode: 0, stdout });

    expect(result.isErr() && result.error).toBeInstanceOf(ImageBuildFailed);
    expect(result.isErr() && result.error.message).toContain(image);
    expect(result.isErr() && result.error.message).toContain(stdout);
    expect(result.isErr() && result.error.output).toBe(stdout);
  });

  it('reports labels whose values are not strings as unreadable', () => {
    const image = faker.word.noun();
    const stdout = JSON.stringify({ [faker.word.noun()]: faker.number.int() });

    const result = classifyInspect(image, { exitCode: 0, stdout });

    expect(result.isErr() && result.error).toBeInstanceOf(ImageBuildFailed);
    expect(result.isErr() && result.error.message).toContain(image);
    expect(result.isErr() && result.error.message).toContain(stdout);
    expect(result.isErr() && result.error.output).toBe(stdout);
  });

  it('reports an image that is not there as absent, not as a failure', () => {
    const image = faker.word.noun();

    const result = classifyInspect(image, {
      exitCode: 1,
      stderr: `Error: No such image: ${image}`,
    });

    expect(result.unwrap()).toBeUndefined();
  });

  it("carries docker's own words when docker could not be queried", () => {
    const stderr = `Cannot connect to the Docker daemon ${faker.lorem.sentence()}`;

    const result = classifyInspect(faker.word.noun(), { exitCode: 1, stderr: `${stderr}\n` });

    expect(result.isErr() && result.error.message).toContain(stderr);
    expect(result.isErr() && result.error.output).toBe(stderr);
  });

  it('carries why docker did not run when the process never started', () => {
    const shortMessage = `Command failed with ENOENT: docker ${faker.lorem.words(3)}`;

    const result = classifyInspect(faker.word.noun(), { shortMessage, stderr: 'No such image' });

    expect(result.isErr() && result.error.message).toContain(shortMessage);
    expect(result.isErr() && result.error.output).toBe(shortMessage);
  });
});

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
