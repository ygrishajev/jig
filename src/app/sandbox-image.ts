import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultImageName } from '@ai-hero/sandcastle/sandboxes/docker';
import type { Logger } from 'pino';
import {
  agentLayerDockerfile,
  DOCKERFILE,
  formatAgentVersions,
  LABELS,
  parseAgentVersions,
  recipeHash,
  SANDBOX_DIRECTORY,
  type AgentInstall,
} from '../adapters/sandbox-image/image-recipe.js';
import { AGENTS } from '../adapters/sandcastle/agents.js';
import { configuredSteps, type SdlcConfig } from '../config/load-config.js';
import { ConfigInvalid } from '../domain/errors.js';
import type { SandboxImages } from '../ports/sandbox-images.js';

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
  warnings: string[];
}

/**
 * Decides what to rebuild from the image's labels: everything when the Dockerfile changed or
 * there is no image, only the agent layer when the agents or their versions changed, nothing
 * otherwise. Without a pin, an agent follows `policy`: `auto` takes the latest release, `warn`
 * keeps the installed one and says a newer one exists, `off` never looks.
 */
export function planImageBuild(input: {
  labels: Record<string, string> | undefined;
  dockerfileHash: string;
  agentsNeeded: AgentNeeded[];
  policy: AgentUpdatePolicy;
}): ImageBuildPlan {
  const { labels, dockerfileHash, agentsNeeded, policy } = input;
  const installed = parseAgentVersions(labels?.[LABELS.agentVersions]);
  const warnings: string[] = [];
  const agents = agentsNeeded.map((agent) => {
    const current = installed[agent.name];
    const newer = agent.latest && current && agent.latest !== current ? agent.latest : undefined;
    if (!agent.pinned && policy === 'warn' && newer) {
      warnings.push(
        `${agent.name} ${newer} is available (installed: ${current}) — run sdlc build --pull-agents`,
      );
    }
    const version =
      agent.pinned ??
      (policy === 'auto' ? (agent.latest ?? current) : (current ?? agent.latest)) ??
      'latest';
    return { name: agent.name, npmPackage: agent.npmPackage, version };
  });

  const wantedAgents = agents
    .map((agent) => agent.name)
    .sort()
    .join(',');
  const changedVersions = agents
    .filter((agent) => installed[agent.name] !== agent.version)
    .map((agent) => `${agent.name} ${installed[agent.name] ?? 'none'} → ${agent.version}`);

  const plan = (action: ImageBuildPlan['action'], reason: string) => ({
    action,
    reason,
    agents,
    warnings,
  });
  if (!labels) return plan('all', 'no sandbox image yet');
  if (labels[LABELS.dockerfileHash] !== dockerfileHash)
    return plan('all', 'the sandbox Dockerfile changed');
  if (labels[LABELS.agents] !== wantedAgents)
    return plan('agents', `agents changed to ${wantedAgents}`);
  if (changedVersions.length > 0) return plan('agents', changedVersions.join(', '));
  return plan('none', 'the sandbox image is up to date');
}

export function sandboxImageName(repoRoot: string, config: SdlcConfig) {
  return config.sandboxImage ?? defaultImageName(repoRoot);
}

export function baseImageName(image: string) {
  const lastSlash = image.lastIndexOf('/');
  return image.lastIndexOf(':') > lastSlash ? `${image}-base` : `${image}:base`;
}

export interface EnsureImageDependencies {
  repoRoot: string;
  config: SdlcConfig;
  images: SandboxImages;
  latestVersions: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
  logger: Logger;
}

/**
 * Makes sure the sandbox image matches the repository's Dockerfile and the agents the config
 * uses, building only what changed. An image named in `sandboxImage` is managed elsewhere and
 * used as it is.
 */
export async function ensureSandboxImage(
  d: EnsureImageDependencies,
  options: { pullAgents?: boolean } = {},
) {
  const image = sandboxImageName(d.repoRoot, d.config);
  if (d.config.sandboxImage) return image;

  const dockerfile = await readSandboxDockerfile(d.repoRoot);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const policy: AgentUpdatePolicy = options.pullAgents ? 'auto' : d.config.agentUpdates;
  const plan = planImageBuild({
    labels: await d.images.labels(image),
    dockerfileHash: recipeHash(dockerfile, uid, gid),
    agentsNeeded: await agentsNeeded(d, policy),
    policy,
  });
  for (const warning of plan.warnings) d.logger.warn(warning);
  if (plan.action === 'none') return image;

  d.logger.info(`building the sandbox image ${image}: ${plan.reason}`);
  const base = baseImageName(image);
  const buildArgs = { AGENT_UID: uid, AGENT_GID: gid };
  if (plan.action === 'all' || !(await d.images.labels(base))) {
    await d.images.build({ tag: base, contextDirectory: sandboxDirectory(d.repoRoot), buildArgs });
  }
  await d.images.build({
    tag: image,
    dockerfile: agentLayerDockerfile(base, plan.agents),
    buildArgs,
    labels: {
      [LABELS.dockerfileHash]: recipeHash(dockerfile, uid, gid),
      [LABELS.agents]: plan.agents
        .map((agent) => agent.name)
        .sort()
        .join(','),
      [LABELS.agentVersions]: formatAgentVersions(plan.agents),
    },
  });
  return image;
}

async function agentsNeeded(d: EnsureImageDependencies, policy: AgentUpdatePolicy) {
  const names = [...new Set(Object.values(configuredSteps(d.config)).map((step) => step.provider))];
  const packages = names.map((name) => AGENTS[name].npmPackage);
  const latest = policy === 'off' ? {} : await d.latestVersions(packages);
  return names.map((name) => ({
    name,
    npmPackage: AGENTS[name].npmPackage,
    pinned: d.config.agents[name],
    latest: latest[AGENTS[name].npmPackage],
  }));
}

function sandboxDirectory(repoRoot: string) {
  return path.join(repoRoot, SANDBOX_DIRECTORY);
}

async function readSandboxDockerfile(repoRoot: string) {
  const file = path.join(sandboxDirectory(repoRoot), DOCKERFILE);
  if (!existsSync(file)) {
    throw new ConfigInvalid(
      `No sandbox Dockerfile at ${path.join(SANDBOX_DIRECTORY, DOCKERFILE)} — run sdlc init first.`,
    );
  }
  return readFile(file, 'utf-8');
}
