import { execa } from 'execa';

export interface BuildInput {
  tag: string;
  /** Build from this directory's Dockerfile, or from `dockerfile` text with no context. */
  contextDirectory?: string;
  dockerfile?: string;
  buildArgs: Record<string, string | number>;
  labels?: Record<string, string>;
}

export interface DockerImagesOptions {
  /** `gha` shares layers between CI jobs through GitHub Actions' cache, via buildx. */
  cache?: 'gha';
  onOutput?: (line: string) => void;
}

/** The few docker CLI calls image management needs. */
export class DockerImages {
  constructor(private readonly options: DockerImagesOptions = {}) {}

  /** The image's labels, or undefined when the image is not on this machine. */
  async labels(image: string): Promise<Record<string, string> | undefined> {
    const result = await execa(
      'docker',
      ['image', 'inspect', image, '--format', '{{json .Config.Labels}}'],
      {
        reject: false,
      },
    );
    if (result.exitCode !== 0) return undefined;
    return (JSON.parse(result.stdout) as Record<string, string> | null) ?? {};
  }

  async build(input: BuildInput) {
    const args = [...this.builder(input.tag), '-t', input.tag];
    for (const [name, value] of Object.entries(input.buildArgs))
      args.push('--build-arg', `${name}=${value}`);
    for (const [name, value] of Object.entries(input.labels ?? {}))
      args.push('--label', `${name}=${value}`);
    args.push(...(input.dockerfile !== undefined ? ['-'] : [input.contextDirectory ?? '.']));

    const build = execa('docker', args, { input: input.dockerfile, all: true, reject: false });
    build.all?.on('data', (chunk: Buffer) => this.options.onOutput?.(chunk.toString()));
    const result = await build;
    if (result.exitCode !== 0) {
      throw new Error(
        `Building ${input.tag} failed:\n${(result.all ?? '').split('\n').slice(-30).join('\n')}`,
      );
    }
  }

  private builder(tag: string) {
    if (this.options.cache !== 'gha') return ['build'];
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
}
