import { type Result, TaggedError } from 'better-result';

/** The images on this machine, as the sandbox image decision needs them. */
export interface SandboxImages {
  /** The image's labels, or undefined when the image is not on this machine. */
  labels(tag: string): Promise<Result<Record<string, string> | undefined, ImageBuildFailed>>;
  build(spec: ImageBuildSpec): Promise<Result<void, ImageBuildFailed>>;
}

export interface ImageBuildSpec {
  tag: string;
  /** Build from this directory's Dockerfile, or from `dockerfile` text with no context. */
  contextDirectory?: string;
  dockerfile?: string;
  buildArgs: Record<string, string | number>;
  labels?: Record<string, string>;
}

/** A sandbox image could not be built, or docker could not be asked about one; `output` is what docker said. */
export class ImageBuildFailed extends TaggedError('ImageBuildFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'fatal' as const;
}
