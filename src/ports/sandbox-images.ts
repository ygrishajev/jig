import type { Result } from 'better-result';

import type { ImageBuildFailed } from './sandbox.js';

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
