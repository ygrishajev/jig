import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCKERFILE, LABELS, SANDBOX_DIRECTORY } from '../adapters/sandbox-image/image-recipe.js';
import { loadConfig } from '../config/load-config.js';
import type { ImageBuildSpec, SandboxImages } from '../ports/sandbox-images.js';
import {
  agentVersion,
  baseImageName,
  ensureSandboxImage,
  planImageBuild,
  sandboxImageName,
  type AgentNeeded,
  type AgentUpdatePolicy,
} from './sandbox-image.js';

class FakeSandboxImages implements SandboxImages {
  readonly built: ImageBuildSpec[] = [];
  private readonly images = new Map<string, Record<string, string>>();

  async labels(tag: string) {
    return this.images.get(tag);
  }

  async build(spec: ImageBuildSpec) {
    this.built.push(spec);
    this.images.set(spec.tag, spec.labels ?? {});
  }

  forget() {
    this.built.length = 0;
  }
}

describe('ensureSandboxImage', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
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

  it('uses an image named in the config as it is', async () => {
    const sandboxImage = faker.word.noun();
    const { ensure, images } = await setup({ sandboxImage });

    expect(await ensure()).toBe(sandboxImage);
    expect(images.built).toEqual([]);
  });

  async function setup(input: { sandboxImage?: string; latest?: () => string }) {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-image-'));
    directories.push(repoRoot);
    const writeDockerfile = async (contents: string) => {
      await mkdir(path.join(repoRoot, SANDBOX_DIRECTORY), { recursive: true });
      await writeFile(path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE), contents);
    };
    await writeDockerfile(faker.lorem.lines(3));
    const config = { ...loadConfig(repoRoot), sandboxImage: input.sandboxImage };
    const fixedLatest = faker.system.semver();
    const latestVersion = input.latest ?? (() => fixedLatest);
    const images = new FakeSandboxImages();
    const ensure = () =>
      ensureSandboxImage({
        repoRoot,
        config,
        images,
        latestVersions: async (packages) =>
          Object.fromEntries(packages.map((npmPackage) => [npmPackage, latestVersion()])),
        logger: pino({ level: 'silent' }),
      });
    return { ensure, images, image: sandboxImageName(repoRoot, config), writeDockerfile };
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
