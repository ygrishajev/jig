/** The images on this machine, as the sandbox image decision needs them. */
export interface SandboxImages {
  /** The image's labels, or undefined when the image is not on this machine. */
  labels(tag: string): Promise<Record<string, string> | undefined>;
  build(spec: ImageBuildSpec): Promise<void>;
}

export interface ImageBuildSpec {
  tag: string;
  /** Build from this directory's Dockerfile, or from `dockerfile` text with no context. */
  contextDirectory?: string;
  dockerfile?: string;
  buildArgs: Record<string, string | number>;
  labels?: Record<string, string>;
}
