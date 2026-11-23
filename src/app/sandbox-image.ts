import { defaultImageName } from '@ai-hero/sandcastle/sandboxes/docker';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';

import {
  type AgentInstall,
  agentLayerDockerfile,
  DOCKERFILE,
  imageLabels,
  LABELS,
  parseAgentVersions,
  recipeHash,
  SANDBOX_DIRECTORY,
} from '../adapters/sandbox-image/image-recipe.js';
import { AGENTS } from '../adapters/sandcastle/agents.js';
import type { ConfigInvalid } from '../config/errors.js';
import { configuredSteps, type JigConfig, type StepConfig } from '../config/load-config.js';
import { messageOf } from '../failures/messages.js';
import { SandboxPreparationInvalid } from '../ports/agent-session.js';
import type { ImageBuildFailed, SandboxImages } from '../ports/sandbox-images.js';

export interface EnsureImageDependencies {
  repoRoot: string;
  config: JigConfig;
  images: SandboxImages;
  latestVersions: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
  logger: Logger;
}

interface ImageRecipe {
  dockerfileHash: string;
  buildArgs: Record<string, number>;
}

export type AgentUpdatePolicy = 'auto' | 'warn' | 'off';

export interface AgentNeeded {
  name: string;
  npmPackage: string;
  pinned?: string;
  latest?: string;
}

export interface ImageBuildPlan {
  action: 'none' | 'agents' | 'all';
  reason: string;
  agents: AgentInstall[];
  /** The labels the rebuilt image carries; the next plan compares an image's labels with these. */
  labels: Record<string, string>;
  warnings: string[];
}

/**
 * Makes sure the sandbox image matches the repository's Dockerfile and the agents the config
 * uses, building only what changed. An image named in `sandboxImage` is managed elsewhere and
 * used as it is.
 */
export async function ensureSandboxImage(
  d: EnsureImageDependencies,
  options: { pullAgents?: boolean } = {},
): Promise<Result<string, ConfigInvalid | SandboxPreparationInvalid | ImageBuildFailed>> {
  const image = sandboxImageName(d.repoRoot, d.config);
  if (d.config.sandboxImage) return Result.ok(image);

  return Result.gen(async function* () {
    const steps = yield* configuredSteps(d.config);
    const recipe = yield* Result.await(readRecipe(d.repoRoot));
    const policy = options.pullAgents ? 'auto' : d.config.agentUpdates;
    const plan = planImageBuild({
      labels: yield* Result.await(d.images.labels(image)),
      dockerfileHash: recipe.dockerfileHash,
      agentsNeeded: await agentsNeeded(d, Object.values(steps), policy),
      policy,
    });
    for (const warning of plan.warnings) d.logger.warn(warning);
    if (plan.action !== 'none') {
      yield* Result.await(buildImage(d, image, plan, recipe.buildArgs));
    }
    return Result.ok(image);
  });
}

export function sandboxImageName(repoRoot: string, config: JigConfig): string {
  return config.sandboxImage ?? defaultImageName(repoRoot);
}

/** The image is built for the host user, so files the agent writes in the worktree stay the operator's. */
async function readRecipe(
  repoRoot: string,
): Promise<Result<ImageRecipe, SandboxPreparationInvalid>> {
  const dockerfile = await readSandboxDockerfile(repoRoot);
  if (dockerfile.isErr()) return Result.err(dockerfile.error);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return Result.ok({
    dockerfileHash: recipeHash(dockerfile.value, uid, gid),
    buildArgs: { AGENT_UID: uid, AGENT_GID: gid },
  });
}

export async function readSandboxDockerfile(
  repoRoot: string,
): Promise<Result<string, SandboxPreparationInvalid>> {
  const file = path.join(sandboxDirectory(repoRoot), DOCKERFILE);
  const shown = path.join(SANDBOX_DIRECTORY, DOCKERFILE);
  if (!existsSync(file)) {
    return Result.err(
      new SandboxPreparationInvalid({
        message: `No sandbox Dockerfile at ${shown} — run jig init first.`,
      }),
    );
  }
  return Result.tryPromise({
    try: () => readFile(file, 'utf-8'),
    catch: (cause) =>
      new SandboxPreparationInvalid({
        message: `Could not read the sandbox Dockerfile at ${shown}: ${messageOf(cause)}`,
      }),
  });
}

function sandboxDirectory(repoRoot: string): string {
  return path.join(repoRoot, SANDBOX_DIRECTORY);
}

/**
 * Decides what to rebuild from the image's labels: everything when the Dockerfile changed or
 * there is no image, only the agent layer when the agents or their versions changed, nothing
 * otherwise.
 */
export function planImageBuild(input: {
  labels: Record<string, string> | undefined;
  dockerfileHash: string;
  agentsNeeded: AgentNeeded[];
  policy: AgentUpdatePolicy;
}): ImageBuildPlan {
  const installed = parseAgentVersions(input.labels?.[LABELS.agentVersions]);
  const agents = input.agentsNeeded.map((agent) => ({
    name: agent.name,
    npmPackage: agent.npmPackage,
    version: agentVersion(agent, installed[agent.name], input.policy),
  }));
  const warnings = input.agentsNeeded.flatMap((agent) =>
    newerReleaseWarning(agent, installed[agent.name], input.policy),
  );
  const labels = imageLabels(input.dockerfileHash, agents);
  const decision = rebuildDecision(input.labels, labels, versionChanges(installed, agents));
  return { ...decision, agents, labels, warnings };
}

/**
 * A pin always wins. Without one, `auto` takes the latest release, `warn` and `off` keep the
 * installed one; either falls back to the other, and to npm's `latest` when neither is known.
 */
export function agentVersion(
  agent: AgentNeeded,
  installed: string | undefined,
  policy: AgentUpdatePolicy,
): string {
  if (agent.pinned !== undefined) return agent.pinned;
  const preferred = policy === 'auto' ? [agent.latest, installed] : [installed, agent.latest];
  return preferred.find((version) => version !== undefined) ?? 'latest';
}

function newerReleaseWarning(
  agent: AgentNeeded,
  installed: string | undefined,
  policy: AgentUpdatePolicy,
): string[] {
  if (agent.pinned !== undefined || policy !== 'warn') return [];
  if (!agent.latest || !installed || agent.latest === installed) return [];
  return [
    `${agent.name} ${agent.latest} is available (installed: ${installed}) — run jig build --pull-agents`,
  ];
}

function rebuildDecision(
  installed: Record<string, string> | undefined,
  wanted: Record<string, string>,
  changedVersions: string,
): Pick<ImageBuildPlan, 'action' | 'reason'> {
  if (!installed) return { action: 'all', reason: 'no sandbox image yet' };
  if (installed[LABELS.dockerfileHash] !== wanted[LABELS.dockerfileHash])
    return { action: 'all', reason: 'the sandbox Dockerfile changed' };
  if (installed[LABELS.agents] !== wanted[LABELS.agents])
    return { action: 'agents', reason: `agents changed to ${wanted[LABELS.agents]}` };
  if (installed[LABELS.agentVersions] !== wanted[LABELS.agentVersions])
    return { action: 'agents', reason: changedVersions };
  return { action: 'none', reason: 'the sandbox image is up to date' };
}

function versionChanges(installed: Record<string, string>, agents: AgentInstall[]): string {
  return agents
    .filter((agent) => installed[agent.name] !== agent.version)
    .map((agent) => `${agent.name} ${installed[agent.name] ?? 'none'} → ${agent.version}`)
    .join(', ');
}

async function agentsNeeded(
  d: EnsureImageDependencies,
  steps: StepConfig[],
  policy: AgentUpdatePolicy,
): Promise<AgentNeeded[]> {
  const names = [...new Set(steps.map((step) => step.provider))];
  const packages = names.map((name) => AGENTS[name].npmPackage);
  const latest = policy === 'off' ? {} : await d.latestVersions(packages);
  return names.map((name) => ({
    name,
    npmPackage: AGENTS[name].npmPackage,
    pinned: d.config.agents[name],
    latest: latest[AGENTS[name].npmPackage],
  }));
}

async function buildImage(
  d: EnsureImageDependencies,
  image: string,
  plan: ImageBuildPlan,
  buildArgs: Record<string, number>,
): Promise<Result<void, ImageBuildFailed>> {
  return Result.gen(async function* () {
    d.logger.info(`building the sandbox image ${image}: ${plan.reason}`);
    const base = baseImageName(image);
    if (plan.action === 'all' || !(yield* Result.await(d.images.labels(base)))) {
      yield* Result.await(
        d.images.build({ tag: base, contextDirectory: sandboxDirectory(d.repoRoot), buildArgs }),
      );
    }
    yield* Result.await(
      d.images.build({
        tag: image,
        dockerfile: agentLayerDockerfile(base, plan.agents),
        buildArgs,
        labels: plan.labels,
      }),
    );
    return Result.ok();
  });
}

export function baseImageName(image: string): string {
  const lastSlash = image.lastIndexOf('/');
  return image.lastIndexOf(':') > lastSlash ? `${image}-base` : `${image}:base`;
}
