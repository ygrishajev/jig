import { createHash } from 'node:crypto';

import { ConfigInvalid } from '../../domain/errors.js';

export const SANDBOX_DIRECTORY = '.sandcastle';
export const DOCKERFILE = 'Dockerfile';

export const TOOLCHAIN_START =
  '# --- project toolchain (yours: what setupCommand and verifyCommand need) ---';
export const TOOLCHAIN_END = '# --- end project toolchain ---';

export const LABELS = {
  dockerfileHash: 'jig.dockerfile-hash',
  agents: 'jig.agents',
  agentVersions: 'jig.agent-versions',
} as const;

/**
 * The repository's sandbox image without agents: base tools, then the project's toolchain, then
 * the `agent` user. The toolchain comes before the UID so its layers are cached across machines.
 */
export const BASE_DOCKERFILE = [
  'FROM node:22-bookworm',
  '',
  'RUN apt-get update \\',
  '    && apt-get install -y --no-install-recommends git curl jq ripgrep ca-certificates procps \\',
  '    && rm -rf /var/lib/apt/lists/*',
  '',
  TOOLCHAIN_START,
  TOOLCHAIN_END,
  '',
  'ARG AGENT_UID=1000',
  'ARG AGENT_GID=1000',
  'RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node',
  'USER ${AGENT_UID}:${AGENT_GID}',
  'WORKDIR /home/agent',
  '',
].join('\n');

export interface AgentInstall {
  name: string;
  npmPackage: string;
  version: string;
}

/** The layer jig owns: the agent CLIs the config uses, at exact versions, on top of the base image. */
export function agentLayerDockerfile(baseImage: string, agents: AgentInstall[]) {
  const packages = agents.map((agent) => `${agent.npmPackage}@${agent.version}`).join(' ');
  return [
    `FROM ${baseImage}`,
    'USER root',
    `RUN npm install -g ${packages} && rm -rf /tmp/opencode`,
    'ARG AGENT_UID=1000',
    'ARG AGENT_GID=1000',
    'USER ${AGENT_UID}:${AGENT_GID}',
    'ENTRYPOINT ["sleep", "infinity"]',
    '',
  ].join('\n');
}

/** Replaces whatever sits between the toolchain markers, leaving the rest of the Dockerfile alone. */
export function withToolchain(dockerfile: string, toolchain: string) {
  const start = dockerfile.indexOf(TOOLCHAIN_START);
  const end = dockerfile.indexOf(TOOLCHAIN_END);
  if (start === -1 || end === -1 || end < start) {
    throw new ConfigInvalid(`The Dockerfile has no "${TOOLCHAIN_START}" section to fill in.`);
  }
  const body = toolchain.trim();
  return [
    dockerfile.slice(0, start + TOOLCHAIN_START.length),
    ...(body ? [body] : []),
    dockerfile.slice(end),
  ].join('\n');
}

/** Changes whenever the Dockerfile or the user it is built for changes. */
export function recipeHash(dockerfile: string, uid: number, gid: number) {
  return createHash('sha256').update(`${uid}:${gid}\n${dockerfile}`).digest('hex').slice(0, 16);
}

export function formatAgentVersions(agents: AgentInstall[]) {
  return [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent) => `${agent.name}=${agent.version}`)
    .join(',');
}

/** What the sandbox image is labelled with, and what a later run compares against to decide what to rebuild. */
export function imageLabels(
  dockerfileHash: string,
  agents: AgentInstall[],
): Record<string, string> {
  return {
    [LABELS.dockerfileHash]: dockerfileHash,
    [LABELS.agents]: agents
      .map((agent) => agent.name)
      .sort()
      .join(','),
    [LABELS.agentVersions]: formatAgentVersions(agents),
  };
}

/** Reads the label `formatAgentVersions` wrote; an entry without a version counts as not installed. */
export function parseAgentVersions(label: string | undefined): Record<string, string> {
  if (!label) return {};
  return Object.fromEntries(label.split(',').flatMap(agentVersionEntry));
}

function agentVersionEntry(entry: string): [string, string][] {
  const separator = entry.indexOf('=');
  if (separator <= 0 || separator === entry.length - 1) return [];
  return [[entry.slice(0, separator), entry.slice(separator + 1)]];
}
