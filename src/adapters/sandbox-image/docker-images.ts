import { Result } from 'better-result';
import { execa } from 'execa';
import { z } from 'zod';

import { ImageBuildFailed, messageOf } from '../../domain/errors.js';
import type { ImageBuildSpec, SandboxImages } from '../../ports/sandbox-images.js';

export interface DockerImagesOptions {
  cache?: BuildCache;
  onOutput?: (line: string) => void;
}

type BuildCache = 'gha';

export class DockerImages implements SandboxImages {
  constructor(private readonly options: DockerImagesOptions = {}) {}

  async labels(
    image: string,
  ): Promise<Result<Record<string, string> | undefined, ImageBuildFailed>> {
    const inspected = await runDocker(
      execa('docker', ['image', 'inspect', image, '--format', '{{json .Config.Labels}}'], {
        reject: false,
      }),
      `Could not ask docker about ${image}`,
    );
    if (inspected.isErr()) return Result.err(inspected.error);
    const { exitCode, stdout, stderr } = inspected.value;
    if (exitCode === 0) return Result.ok(imageLabelsSchema.parse(JSON.parse(stdout)) ?? {});
    if (NO_SUCH_IMAGE.test(stderr)) return Result.ok(undefined);
    return Result.err(
      new ImageBuildFailed({ message: `Could not ask docker about ${image}`, output: stderr }),
    );
  }

  async build(spec: ImageBuildSpec): Promise<Result<void, ImageBuildFailed>> {
    const build = execa('docker', dockerBuildArguments(spec, this.options.cache), {
      input: spec.dockerfile,
      all: true,
      reject: false,
    });
    build.all?.on('data', (chunk: Buffer) => this.options.onOutput?.(chunk.toString()));
    const built = await runDocker(build, `Building ${spec.tag} failed`);
    if (built.isErr()) return Result.err(built.error);
    if (built.value.exitCode === 0) return Result.ok();
    const output = (built.value.all ?? '').split('\n').slice(-FAILED_BUILD_OUTPUT_LINES).join('\n');
    return Result.err(
      new ImageBuildFailed({ message: `Building ${spec.tag} failed:\n${output}`, output }),
    );
  }
}

/** The process only fails to start when docker is not installed; anything else is an exit code. */
function runDocker<T>(
  process: PromiseLike<T>,
  message: string,
): Promise<Result<T, ImageBuildFailed>> {
  return Result.tryPromise({
    try: async () => process,
    catch: (cause) =>
      new ImageBuildFailed({ message: `${message}: ${messageOf(cause)}`, output: '' }),
  });
}

/** `docker image inspect` prints `null` for an image built without labels. */
const imageLabelsSchema = z.record(z.string()).nullable();

/** `docker image inspect` of an image that is not there; any other failure is docker's. */
const NO_SUCH_IMAGE = /no such (image|object)/i;

export function dockerBuildArguments(spec: ImageBuildSpec, cache?: BuildCache): string[] {
  return [
    ...builderArguments(spec.tag, cache),
    '-t',
    spec.tag,
    ...flags('--build-arg', spec.buildArgs),
    ...flags('--label', spec.labels ?? {}),
    spec.dockerfile === undefined ? (spec.contextDirectory ?? '.') : '-',
  ];
}

/** `gha` shares layers between CI jobs through GitHub Actions' cache, which needs buildx. */
function builderArguments(tag: string, cache: BuildCache | undefined): string[] {
  if (cache !== 'gha') return ['build'];
  const scope = tag.replace(/[^a-zA-Z0-9-]/g, '-');
  return [
    'buildx',
    'build',
    '--load',
    '--cache-from',
    `type=gha,scope=${scope}`,
    '--cache-to',
    `type=gha,mode=max,scope=${scope}`,
  ];
}

function flags(flag: string, values: Record<string, string | number>): string[] {
  return Object.entries(values).flatMap(([name, value]) => [flag, `${name}=${value}`]);
}

/** How many lines of a failed build's output the error carries. */
const FAILED_BUILD_OUTPUT_LINES = 30;
