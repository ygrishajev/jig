import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { LABELS } from '../adapters/sandbox-image/image-recipe.js';
import {
  baseImageName,
  planImageBuild,
  type AgentNeeded,
  type AgentUpdatePolicy,
} from './sandbox-image.js';

describe('planImageBuild', () => {
  it('builds everything when there is no image yet', () => {
    expect(plan({ labels: undefined }).action).toBe('all');
  });

  it('builds everything when the Dockerfile changed', () => {
    const { labels } = installed({ claude: version() });

    expect(
      plan({ labels, dockerfileHash: faker.string.hexadecimal({ length: 16 }) }),
    ).toMatchObject({
      action: 'all',
      reason: 'the sandbox Dockerfile changed',
    });
  });

  it('builds nothing when the Dockerfile, agents and versions all match', () => {
    const current = version();
    const { labels, hash } = installed({ claude: current });

    expect(
      plan({ labels, dockerfileHash: hash, agents: [claude({ latest: current })] }).action,
    ).toBe('none');
  });

  it('rebuilds only the agent layer when a newer release is out and updates are automatic', () => {
    const current = version();
    const newer = version();
    const { labels, hash } = installed({ claude: current });

    const result = plan({
      labels,
      dockerfileHash: hash,
      agents: [claude({ latest: newer })],
      policy: 'auto',
    });

    expect(result).toMatchObject({
      action: 'agents',
      agents: [{ name: 'claude', version: newer }],
    });
  });

  it('keeps the installed agent and warns when updates are only reported', () => {
    const current = version();
    const newer = version();
    const { labels, hash } = installed({ claude: current });

    const result = plan({
      labels,
      dockerfileHash: hash,
      agents: [claude({ latest: newer })],
      policy: 'warn',
    });

    expect(result.action).toBe('none');
    expect(result.warnings[0]).toContain(newer);
  });

  it('installs a pinned version whatever the latest release is', () => {
    const pinned = version();
    const { labels, hash } = installed({ claude: version() });

    const result = plan({
      labels,
      dockerfileHash: hash,
      agents: [claude({ pinned, latest: version() })],
      policy: 'auto',
    });

    expect(result).toMatchObject({ action: 'agents', agents: [{ version: pinned }] });
  });

  it('rebuilds the agent layer when the config starts using another agent', () => {
    const current = version();
    const { labels, hash } = installed({ claude: current });

    const result = plan({
      labels,
      dockerfileHash: hash,
      agents: [
        claude({ latest: current }),
        { name: 'opencode', npmPackage: 'opencode-ai', latest: version() },
      ],
    });

    expect(result).toMatchObject({ action: 'agents', reason: 'agents changed to claude,opencode' });
  });

  it('keeps what is installed when the registry could not be reached', () => {
    const current = version();
    const { labels, hash } = installed({ claude: current });

    expect(
      plan({ labels, dockerfileHash: hash, agents: [claude({ latest: undefined })] }).action,
    ).toBe('none');
  });

  function plan(input: {
    labels: Record<string, string> | undefined;
    dockerfileHash?: string;
    agents?: AgentNeeded[];
    policy?: AgentUpdatePolicy;
  }) {
    return planImageBuild({
      labels: input.labels,
      dockerfileHash: input.dockerfileHash ?? faker.string.hexadecimal({ length: 16 }),
      agentsNeeded: input.agents ?? [claude({ latest: version() })],
      policy: input.policy ?? 'auto',
    });
  }
});

describe('baseImageName', () => {
  it('derives the agent-free image from the sandbox image name', () => {
    const repo = faker.word.noun();

    expect(baseImageName(`sandcastle:${repo}`)).toBe(`sandcastle:${repo}-base`);
    expect(baseImageName(`localhost:5000/${repo}`)).toBe(`localhost:5000/${repo}:base`);
  });
});

function version() {
  return faker.system.semver();
}

function claude(input: { pinned?: string; latest?: string }): AgentNeeded {
  return { name: 'claude', npmPackage: '@anthropic-ai/claude-code', ...input };
}

function installed(versions: Record<string, string>) {
  const hash = faker.string.hexadecimal({ length: 16 });
  const labels = {
    [LABELS.dockerfileHash]: hash,
    [LABELS.agents]: Object.keys(versions).sort().join(','),
    [LABELS.agentVersions]: Object.entries(versions)
      .map(([name, value]) => `${name}=${value}`)
      .join(','),
  };
  return { labels, hash };
}
