import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { everyStepOn } from '../../tests/support/builders.js';
import { repositoryConfig } from '../../tests/support/repository-config.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { DOCKERFILE, LABELS, SANDBOX_DIRECTORY } from '../adapters/sandbox-image/image-recipe.js';
import { ConfigInvalid, ImageBuildFailed } from '../domain/errors.js';
import type { ImageBuildSpec, SandboxImages } from '../ports/sandbox-images.js';
import {
  type AgentNeeded,
  type AgentUpdatePolicy,
  agentVersion,
  baseImageName,
  ensureSandboxImage,
  planImageBuild,
  sandboxImageName,
} from './sandbox-image.js';

class FakeSandboxImages implements SandboxImages {
  readonly built: ImageBuildSpec[] = [];
  private readonly images = new Map<string, Record<string, string>>();

  failNextBuild: ImageBuildFailed | undefined;

  async labels(tag: string) {
    return Result.ok(this.images.get(tag));
  }

  async build(spec: ImageBuildSpec) {
    if (this.failNextBuild) return Result.err(this.failNextBuild);
    this.built.push(spec);
    this.images.set(spec.tag, spec.labels ?? {});
    return Result.ok();
  }

  forget() {
    this.built.length = 0;
  }

  remove(tag: string) {
    this.images.delete(tag);
  }
}

describe('ensureSandboxImage', () => {
  it('refuses to build until every step has an agent', async () => {
    const { ensure, images } = await setup({ withoutAgents: true });

    const result = await ensure();

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(images.built).toHaveLength(0);
  });

  it('builds the base image and the agent layer when there is no image yet', async () => {
    const { ensure, images, image } = await setup({});

    await ensure();

    expect(images.built.map((spec) => spec.tag)).toEqual([baseImageName(image), image]);
  });

  it('rebuilds the base image and the agent layer when the Dockerfile changed', async () => {
    const { ensure, images, image, writeDockerfile } = await setup({});
    await ensure();
    images.forget();

    await writeDockerfile(faker.lorem.lines(3));
    await ensure();

    expect(images.built.map((spec) => spec.tag)).toEqual([baseImageName(image), image]);
  });

  it('rebuilds only the agent layer when a newer agent release is out', async () => {
    const latest = { value: faker.system.semver() };
    const { ensure, images, image } = await setup({ latest: () => latest.value });
    await ensure();
    images.forget();

    latest.value = faker.system.semver();
    await ensure();

    expect(images.built.map((spec) => spec.tag)).toEqual([image]);
    expect(images.built[0]?.dockerfile).toContain(latest.value);
  });

  it('builds nothing when the image is up to date', async () => {
    const { ensure, images } = await setup({});
    await ensure();
    images.forget();

    await ensure();

    expect(images.built).toEqual([]);
  });

  it('rebuilds a base image that went missing when only the agents changed', async () => {
    const latest = { value: faker.system.semver() };
    const { ensure, images, image } = await setup({ latest: () => latest.value });
    await ensure();
    images.forget();
    images.remove(baseImageName(image));

    latest.value = faker.system.semver();
    await ensure();

    expect(images.built.map((spec) => spec.tag)).toEqual([baseImageName(image), image]);
  });

  it('builds both layers for the host user', async () => {
    const { ensure, images } = await setup({});

    await ensure();

    const hostUser = { AGENT_UID: process.getuid?.(), AGENT_GID: process.getgid?.() };
    expect(images.built.map((spec) => spec.buildArgs)).toEqual([hostUser, hostUser]);
  });

  it('does not ask the registry when agent updates are off, unless asked to pull agents', async () => {
    const { ensure, lookups } = await setup({ agentUpdates: 'off' });

    await ensure();
    expect(lookups()).toBe(0);

    await ensure({ pullAgents: true });
    expect(lookups()).toBe(1);
  });

  it('asks for jig init when the repository has no sandbox Dockerfile', async () => {
    const { ensure, images, removeDockerfile } = await setup({});
    await removeDockerfile();

    const result = await ensure();

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(images.built).toEqual([]);
  });

  it('reports a failed build with its output', async () => {
    const { ensure, images } = await setup({});
    const failure = new ImageBuildFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.lines(2),
    });
    images.failNextBuild = failure;

    const result = await ensure();

    expect(result.isErr() && result.error).toBe(failure);
  });

  it('uses an image named in the config as it is', async () => {
    const sandboxImage = faker.word.noun();
    const { ensure, images } = await setup({ sandboxImage });

    expect((await ensure()).unwrap()).toBe(sandboxImage);
    expect(images.built).toEqual([]);
  });

  async function setup(input: {
    withoutAgents?: boolean;
    sandboxImage?: string;
    latest?: () => string;
    agentUpdates?: AgentUpdatePolicy;
  }) {
    const repoRoot = await tempDirectory('jig-image-');
    const writeDockerfile = async (contents: string) => {
      await mkdir(path.join(repoRoot, SANDBOX_DIRECTORY), { recursive: true });
      await writeFile(path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE), contents);
    };
    await writeDockerfile(faker.lorem.lines(3));
    const removeDockerfile = () => rm(path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE));
    const loaded = repositoryConfig(repoRoot);
    const config = {
      ...loaded,
      ...(input.withoutAgents ? {} : everyStepOn()),
      sandboxImage: input.sandboxImage,
      agentUpdates: input.agentUpdates ?? loaded.agentUpdates,
    };
    const fixedLatest = faker.system.semver();
    const latestVersion = input.latest ?? (() => fixedLatest);
    const images = new FakeSandboxImages();
    let lookups = 0;
    const ensure = (options: { pullAgents?: boolean } = {}) =>
      ensureSandboxImage(
        {
          repoRoot,
          config,
          images,
          latestVersions: async (packages) => {
            lookups++;
            return Object.fromEntries(packages.map((npmPackage) => [npmPackage, latestVersion()]));
          },
          logger: pino({ level: 'silent' }),
        },
        options,
      );
    return {
      ensure,
      images,
      image: sandboxImageName(repoRoot, config),
      writeDockerfile,
      removeDockerfile,
      lookups: () => lookups,
    };
  }
});

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

  it.each<QuietCase>([
    { case: 'a pinned agent', pinned: true, policy: 'warn', latest: true, installed: true },
    { case: 'automatic updates', pinned: false, policy: 'auto', latest: true, installed: true },
    { case: 'updates turned off', pinned: false, policy: 'off', latest: true, installed: true },
    {
      case: 'an unknown latest release',
      pinned: false,
      policy: 'warn',
      latest: false,
      installed: true,
    },
    { case: 'nothing installed', pinned: false, policy: 'warn', latest: true, installed: false },
  ])('does not warn about a newer release for $case', (input) => {
    const current = version();
    const { labels, hash } = installed(input.installed ? { claude: current } : {});

    const result = plan({
      labels: input.installed ? labels : undefined,
      dockerfileHash: hash,
      agents: [
        claude({
          pinned: input.pinned ? version() : undefined,
          latest: input.latest ? `${current}-next` : undefined,
        }),
      ],
      policy: input.policy,
    });

    expect(result.warnings).toEqual([]);
  });

  it('does not warn when the latest release is the one installed', () => {
    const current = version();
    const { labels, hash } = installed({ claude: current });

    const result = plan({
      labels,
      dockerfileHash: hash,
      agents: [claude({ latest: current })],
      policy: 'warn',
    });

    expect(result.warnings).toEqual([]);
  });

  it('names only the agents whose version changes as the reason to rebuild', () => {
    const claudeVersion = version();
    const opencodeVersion = version();
    const newer = `${claudeVersion}-next`;
    const { labels, hash } = installed({ claude: claudeVersion, opencode: opencodeVersion });

    const result = plan({
      labels,
      dockerfileHash: hash,
      agents: [
        claude({ latest: newer }),
        { name: 'opencode', npmPackage: 'opencode-ai', latest: opencodeVersion },
      ],
    });

    expect(result.action).toBe('agents');
    expect(result.reason).toContain(claudeVersion);
    expect(result.reason).toContain(newer);
    expect(result.reason).not.toContain('opencode');
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

  it('labels the image so that planning again against it builds nothing', () => {
    const dockerfileHash = faker.string.hexadecimal({ length: 16 });
    const agents = [
      claude({ latest: version() }),
      { name: 'opencode', npmPackage: 'opencode-ai', latest: version() },
    ];
    const first = plan({ labels: undefined, dockerfileHash, agents });

    expect(plan({ labels: first.labels, dockerfileHash, agents }).action).toBe('none');
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

describe('agentVersion', () => {
  it('installs the pin whatever the policy', () => {
    const pinned = version();
    const policy = faker.helpers.arrayElement<AgentUpdatePolicy>(['auto', 'warn', 'off']);

    expect(agentVersion(claude({ pinned, latest: version() }), version(), policy)).toBe(pinned);
  });

  it('takes the latest release when updates are automatic', () => {
    const latest = version();

    expect(agentVersion(claude({ latest }), version(), 'auto')).toBe(latest);
  });

  it('keeps the installed version when updates are not automatic', () => {
    const installed = version();
    const policy = faker.helpers.arrayElement<AgentUpdatePolicy>(['warn', 'off']);

    expect(agentVersion(claude({ latest: version() }), installed, policy)).toBe(installed);
  });

  it('installs the latest release when nothing is installed yet', () => {
    const latest = version();

    expect(agentVersion(claude({ latest }), undefined, 'off')).toBe(latest);
  });

  it('asks npm for its latest tag when no version is known', () => {
    const policy = faker.helpers.arrayElement<AgentUpdatePolicy>(['auto', 'warn', 'off']);

    expect(agentVersion(claude({}), undefined, policy)).toBe('latest');
  });
});

describe('baseImageName', () => {
  it('derives the agent-free image from the sandbox image name', () => {
    const repo = faker.word.noun();

    expect(baseImageName(`sandcastle:${repo}`)).toBe(`sandcastle:${repo}-base`);
    expect(baseImageName(`localhost:5000/${repo}`)).toBe(`localhost:5000/${repo}:base`);
    expect(baseImageName(repo)).toBe(`${repo}:base`);
  });
});

interface QuietCase {
  case: string;
  pinned: boolean;
  policy: AgentUpdatePolicy;
  latest: boolean;
  installed: boolean;
}

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
