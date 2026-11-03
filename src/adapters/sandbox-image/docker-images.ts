import { execa } from 'execa';
import { z } from 'zod';

import type { ImageBuildSpec, SandboxImages } from '../../ports/sandbox-images.js';

export interface DockerImagesOptions {
  cache?: BuildCache;
  onOutput?: (line: string) => void;
}

type BuildCache = 'gha';

export class DockerImages implements SandboxImages {
  constructor(private readonly options: DockerImagesOptions = {}) {}

  async labels(image: string): Promise<Record<string, string> | undefined> {
    const result = await execa(
      'docker',
      ['image', 'inspect', image, '--format', '{{json .Config.Labels}}'],
      { reject: false },
    );
    if (result.exitCode !== 0) return undefined;
    return imageLabelsSchema.parse(JSON.parse(result.stdout)) ?? {};
  }

  async build(spec: ImageBuildSpec): Promise<void> {
    const build = execa('docker', dockerBuildArguments(spec, this.options.cache), {
      input: spec.dockerfile,
      all: true,
      reject: false,
    });
    build.all?.on('data', (chunk: Buffer) => this.options.onOutput?.(chunk.toString()));
    const result = await build;
    if (result.exitCode !== 0) {
      const output = (result.all ?? '').split('\n').slice(-FAILED_BUILD_OUTPUT_LINES).join('\n');
      throw new Error(`Building ${spec.tag} failed:\n${output}`);
    }
  }
}

/** `docker image inspect` prints `null` for an image built without labels. */
const imageLabelsSchema = z.record(z.string()).nullable();

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
