import { defaultImageName } from '@ai-hero/sandcastle/sandboxes/docker';
import { Result } from 'better-result';
import path from 'node:path';

import type { AgentName } from '../../config/agent-policy.js';
import type { JigConfig } from '../../config/load-config.js';
import type { SandboxPreparationInvalid } from '../../ports/agent-session.js';
import type {
  AgentInstall,
  BaseImageRecipe,
  ImageStamp,
  SandboxImageRecipe,
} from '../../ports/sandbox-images.js';
import { AGENTS } from '../sandcastle/agents.js';
import {
  agentLayerDockerfile,
  imageLabels,
  imageStamp,
  recipeHash,
  SANDBOX_DIRECTORY,
} from './image-recipe.js';
import { readSandboxDockerfile } from './starter-files.js';

/** The repository's `.sandcastle/Dockerfile`, built for the host user, with jig's agent layer on top. */
export class RepositoryImageRecipe implements SandboxImageRecipe {
  readonly image: string;
  readonly baseImage: string;

  constructor(
    private readonly repoRoot: string,
    config: Pick<JigConfig, 'sandboxImage'>,
  ) {
    this.image = sandboxImageName(repoRoot, config);
    this.baseImage = baseImageName(this.image);
  }

  async base(): Promise<Result<BaseImageRecipe, SandboxPreparationInvalid>> {
    const dockerfile = await readSandboxDockerfile(this.repoRoot);
    if (dockerfile.isErr()) return Result.err(dockerfile.error);
    const uid = process.getuid?.() ?? FALLBACK_HOST_ID;
    const gid = process.getgid?.() ?? FALLBACK_HOST_ID;
    return Result.ok({
      dockerfileHash: recipeHash(dockerfile.value, uid, gid),
      contextDirectory: path.join(this.repoRoot, SANDBOX_DIRECTORY),
      buildArgs: { AGENT_UID: uid, AGENT_GID: gid },
    });
  }

  agentPackage(agent: AgentName): string {
    return AGENTS[agent].npmPackage;
  }

  agentLayer(agents: readonly AgentInstall[]): string {
    return agentLayerDockerfile(this.baseImage, agents);
  }

  stampOf(labels: Record<string, string>): ImageStamp {
    return imageStamp(labels);
  }

  labelsFor(stamp: ImageStamp): Record<string, string> {
    return imageLabels(stamp);
  }
}

/** The image every sandbox of the repository runs: the one the config names, or sandcastle's own. */
export function sandboxImageName(
  repoRoot: string,
  config: Pick<JigConfig, 'sandboxImage'>,
): string {
  return config.sandboxImage ?? defaultImageName(repoRoot);
}

/** The agent-free image the agent layer of `image` is built on. */
export function baseImageName(image: string): string {
  const lastSlash = image.lastIndexOf('/');
  return image.lastIndexOf(':') > lastSlash ? `${image}-base` : `${image}:base`;
}

/** The user and group sandbox images are built for when the platform has none, as on Windows. */
const FALLBACK_HOST_ID = 1000;
