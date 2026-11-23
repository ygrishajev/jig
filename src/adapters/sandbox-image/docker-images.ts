import { Result } from 'better-result';
import { execa } from 'execa';
import { z } from 'zod';

import { ImageBuildFailed } from '../../domain/errors.js';
import { messageOf } from '../../failures/messages.js';
import type { ImageBuildSpec, SandboxImages } from '../../ports/sandbox-images.js';

export interface DockerImagesOptions {
  cache?: BuildCache;
  onOutput?: (line: string) => void;
}

type BuildCache = 'gha';

/** What `docker` left behind; `exitCode` is undefined when the process never started, e.g. docker is not installed. */
export interface DockerOutcome {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  all?: string;
  shortMessage?: string;
}

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
    return classifyInspect(image, inspected.value);
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
    const output = didNotStart(built.value)
      ? dockerFailure(built.value)
      : (built.value.all ?? '').split('\n').slice(-FAILED_BUILD_OUTPUT_LINES).join('\n');
    return Result.err(
      new ImageBuildFailed({ message: `Building ${spec.tag} failed:\n${output}`, output }),
    );
  }
}

/** Awaiting the process should not reject with `reject: false`; if it does, the cause still reaches the operator. */
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

/** An image's labels, `undefined` when docker says the image is not there, or why docker could not say. */
export function classifyInspect(
  image: string,
  outcome: DockerOutcome,
): Result<Record<string, string> | undefined, ImageBuildFailed> {
  if (outcome.exitCode === 0) return parseLabels(image, outcome.stdout ?? '');
  if (!didNotStart(outcome) && NO_SUCH_IMAGE.test(outcome.stderr ?? ''))
    return Result.ok(undefined);
  const output = dockerFailure(outcome);
  return Result.err(
    new ImageBuildFailed({ message: `Could not ask docker about ${image}: ${output}`, output }),
  );
}

function parseLabels(
  image: string,
  stdout: string,
): Result<Record<string, string>, ImageBuildFailed> {
  const unreadableLabels = (): ImageBuildFailed =>
    new ImageBuildFailed({
      message: `Docker returned labels for ${image} that jig cannot read: ${stdout}`,
      output: stdout,
    });
  return Result.try({ try: (): unknown => JSON.parse(stdout), catch: unreadableLabels }).andThen(
    (json) => {
      const labels = imageLabelsSchema.safeParse(json);
      return labels.success ? Result.ok(labels.data ?? {}) : Result.err(unreadableLabels());
    },
  );
}

/** `docker image inspect` prints `null` for an image built without labels. */
const imageLabelsSchema = z.record(z.string()).nullable();

function didNotStart(outcome: DockerOutcome): boolean {
  return outcome.exitCode === undefined;
}

/** `docker image inspect` of an image that is not there; any other failure is docker's. */
const NO_SUCH_IMAGE = /no such (image|object)/i;

/** Docker's own words, or execa's account of why docker did not run at all. */
function dockerFailure(outcome: DockerOutcome): string {
  return (didNotStart(outcome) ? outcome.shortMessage : outcome.stderr)?.trim() ?? '';
}

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
