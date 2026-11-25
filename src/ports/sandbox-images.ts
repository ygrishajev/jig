import { type Result, TaggedError } from 'better-result';

import type { SandboxPreparationInvalid } from './agent-session.js';

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

/**
 * How the repository's sandbox image is made, and how an image records what it was made from.
 * `image` is the image runs start; `baseImage` is the agent-free image its agent layer sits on.
 */
export interface SandboxImageRecipe {
  readonly image: string;
  readonly baseImage: string;
  base(): Promise<Result<BaseImageRecipe, SandboxPreparationInvalid>>;
  /** The npm package that installs the named agent's CLI. */
  agentPackage(agent: string): string;
  /** The Dockerfile that installs `agents` at their versions on top of `baseImage`. */
  agentLayer(agents: readonly AgentInstall[]): string;
  stampOf(labels: Record<string, string>): ImageStamp;
  labelsFor(stamp: ImageStamp): Record<string, string>;
}

/** The repository's Dockerfile, built for the operator so files the agent writes stay theirs. */
export interface BaseImageRecipe {
  /** Changes whenever the Dockerfile or the user it is built for changes. */
  dockerfileHash: string;
  contextDirectory: string;
  buildArgs: Record<string, number>;
}

/** An agent CLI the sandbox image installs, at the version it pins. */
export interface AgentInstall {
  name: string;
  npmPackage: string;
  version: string;
}

/** What an image was built from: its Dockerfile and the agents it installs. */
export interface ImageStamp {
  readonly dockerfileHash: string | undefined;
  /** Every agent the image installs, by name, whether or not its version is recorded. */
  readonly agents: readonly string[];
  readonly agentVersions: Readonly<Record<string, string>>;
}

/** A sandbox image could not be built, or docker could not be asked about one; `output` is what docker said. */
export class ImageBuildFailed extends TaggedError('ImageBuildFailed')<{
  message: string;
  output: string;
}> {}
