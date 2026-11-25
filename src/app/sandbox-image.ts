import { Result } from 'better-result';

import type { ConfigInvalid } from '../config/errors.js';
import { configuredSteps, type JigConfig, type StepConfig } from '../config/load-config.js';
import type { SandboxPreparationInvalid } from '../ports/agent-session.js';
import type { OperationLog } from '../ports/observability.js';
import type {
  AgentInstall,
  BaseImageRecipe,
  ImageBuildFailed,
  ImageStamp,
  SandboxImageRecipe,
  SandboxImages,
} from '../ports/sandbox-images.js';

export interface EnsureImageDependencies {
  config: JigConfig;
  images: SandboxImages;
  recipe: SandboxImageRecipe;
  latestVersions: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
  log: OperationLog;
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
  /** What the rebuilt image records; the next plan compares an image's stamp with this one. */
  stamp: ImageStamp;
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
  const { image } = d.recipe;
  if (d.config.sandboxImage) return Result.ok(image);

  return Result.gen(async function* () {
    const steps = yield* configuredSteps(d.config);
    const base = yield* Result.await(d.recipe.base());
    const policy = options.pullAgents ? 'auto' : d.config.agentUpdates;
    const plan = planImageBuild({
      installed: yield* Result.await(installedStamp(d, image)),
      dockerfileHash: base.dockerfileHash,
      agentsNeeded: await agentsNeeded(d, Object.values(steps), policy),
      policy,
    });
    for (const warning of plan.warnings) d.log.warn(warning);
    if (plan.action !== 'none') yield* Result.await(buildImage(d, plan, base));
    return Result.ok(image);
  });
}

/**
 * Decides what to rebuild from what the image was built from: everything when the Dockerfile
 * changed or there is no image, only the agent layer when the agents or their versions changed,
 * nothing otherwise.
 */
export function planImageBuild(input: {
  installed: ImageStamp | undefined;
  dockerfileHash: string;
  agentsNeeded: AgentNeeded[];
  policy: AgentUpdatePolicy;
}): ImageBuildPlan {
  const installed = input.installed?.agentVersions ?? {};
  const agents = input.agentsNeeded.map((agent) => ({
    name: agent.name,
    npmPackage: agent.npmPackage,
    version: agentVersion(agent, installed[agent.name], input.policy),
  }));
  const warnings = input.agentsNeeded.flatMap((agent) =>
    newerReleaseWarning(agent, installed[agent.name], input.policy),
  );
  const stamp = stampOf(input.dockerfileHash, agents);
  const decision = rebuildDecision(input.installed, stamp, versionChanges(installed, agents));
  return { ...decision, agents, stamp, warnings };
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

function stampOf(dockerfileHash: string, agents: AgentInstall[]): ImageStamp {
  return {
    dockerfileHash,
    agents: agents.map((agent) => agent.name),
    agentVersions: Object.fromEntries(agents.map((agent) => [agent.name, agent.version])),
  };
}

function rebuildDecision(
  installed: ImageStamp | undefined,
  wanted: ImageStamp,
  changedVersions: string,
): Pick<ImageBuildPlan, 'action' | 'reason'> {
  if (!installed) return { action: 'all', reason: 'no sandbox image yet' };
  if (installed.dockerfileHash !== wanted.dockerfileHash)
    return { action: 'all', reason: 'the sandbox Dockerfile changed' };
  if (agentNames(installed) !== agentNames(wanted))
    return { action: 'agents', reason: `agents changed to ${agentNames(wanted)}` };
  if (agentVersions(installed) !== agentVersions(wanted))
    return { action: 'agents', reason: changedVersions };
  return { action: 'none', reason: 'the sandbox image is up to date' };
}

function agentNames({ agents }: ImageStamp): string {
  return [...agents].sort().join(',');
}

function agentVersions(stamp: ImageStamp): string {
  return Object.entries(stamp.agentVersions)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([name, version]) => `${name}=${version}`)
    .join(',');
}

function versionChanges(installed: Record<string, string>, agents: AgentInstall[]): string {
  return agents
    .filter((agent) => installed[agent.name] !== agent.version)
    .map((agent) => `${agent.name} ${installed[agent.name] ?? 'none'} → ${agent.version}`)
    .join(', ');
}

async function installedStamp(
  { images, recipe }: EnsureImageDependencies,
  image: string,
): Promise<Result<ImageStamp | undefined, ImageBuildFailed>> {
  const labels = await images.labels(image);
  return labels.map((found) => found && recipe.stampOf(found));
}

async function agentsNeeded(
  d: EnsureImageDependencies,
  steps: StepConfig[],
  policy: AgentUpdatePolicy,
): Promise<AgentNeeded[]> {
  const agents = [...new Set(steps.map((step) => step.provider))].map((name) => ({
    name,
    npmPackage: d.recipe.agentPackage(name),
    pinned: d.config.agents[name],
  }));
  const packages = agents.map((agent) => agent.npmPackage);
  const latest = policy === 'off' ? {} : await d.latestVersions(packages);
  return agents.map((agent) => ({ ...agent, latest: latest[agent.npmPackage] }));
}

async function buildImage(
  { images, recipe, log }: EnsureImageDependencies,
  plan: ImageBuildPlan,
  base: BaseImageRecipe,
): Promise<Result<void, ImageBuildFailed>> {
  return Result.gen(async function* () {
    log.info(`building the sandbox image ${recipe.image}: ${plan.reason}`);
    const { buildArgs, contextDirectory } = base;
    if (plan.action === 'all' || !(yield* Result.await(images.labels(recipe.baseImage)))) {
      yield* Result.await(images.build({ tag: recipe.baseImage, contextDirectory, buildArgs }));
    }
    yield* Result.await(
      images.build({
        tag: recipe.image,
        dockerfile: recipe.agentLayer(plan.agents),
        buildArgs,
        labels: recipe.labelsFor(plan.stamp),
      }),
    );
    return Result.ok();
  });
}
