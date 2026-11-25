import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { everyStepOn, presetName } from '../../tests/support/builders.js';
import { InMemoryPresetSource } from '../../tests/support/fakes.js';
import {
  localSandboxRuntime,
  operationContextIn,
  repositorySourcesAt,
} from '../../tests/support/repository-sources.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import {
  BASE_DOCKERFILE,
  DOCKERFILE,
  SANDBOX_DIRECTORY,
} from '../adapters/sandbox-image/image-recipe.js';
import { ConfigInvalid } from '../config/errors.js';
import { RepositoryInvalid } from '../ports/git-failures.js';
import type { OperationLog } from '../ports/observability.js';
import { ImageBuildFailed, type SandboxImages } from '../ports/sandbox-images.js';
import { type BuildImageInput, buildSandboxImage, type RuntimeRequest } from './api.js';
import { sandboxImageName } from './sandbox-image.js';

describe('buildSandboxImage', () => {
  it('builds the image the config names and reports it, releasing what it built', async () => {
    const { build, images, repoRoot, runtimes } = await setup({});

    const report = unwrap(await build());

    expect(
      runtimes()[0]
        ?.settings()
        .map(({ config }) => sandboxImageName(repoRoot, config)),
    ).toEqual([report.image]);
    expect(images.build).toHaveBeenLastCalledWith(expect.objectContaining({ tag: report.image }));
    expect(runtimes()[0]?.disposed()).toBe(true);
  });

  it("reports docker's failure and still releases what it built", async () => {
    const failure = new ImageBuildFailed({
      message: faker.lorem.sentence(),
      output: faker.lorem.paragraph(),
    });
    const { build, runtimes } = await setup({ buildFailure: failure });

    const result = await build();

    expect(result.isErr() && result.error).toBe(failure);
    expect(runtimes()[0]?.disposed()).toBe(true);
  });

  it('looks up the latest agent releases with --pull-agents even when updates are off', async () => {
    const { build, latestVersions } = await setup({ config: { agentUpdates: 'off' } });

    unwrap(await build());
    unwrap(await build({ pullAgents: true }));

    expect(latestVersions).toHaveBeenCalledTimes(1);
  });

  it('uses an image the config names as it is, building nothing', async () => {
    const sandboxImage = `${faker.word.noun()}:${faker.system.semver()}`;
    const { build, images } = await setup({ config: { sandboxImage } });

    const report = unwrap(await build());

    expect(report.image).toBe(sandboxImage);
    expect(images.build).not.toHaveBeenCalled();
  });

  it("builds for the agents a named preset puts on the config's steps", async () => {
    const name = presetName();
    const planner = { provider: 'codex', model: faker.word.noun() } as const;
    const presetSource = new InMemoryPresetSource();
    presetSource.put(0, name, { planner });
    const { build, runtimes } = await setup({ presetSource });

    unwrap(await build({ preset: { kind: 'named', name } }));

    expect(runtimes()[0]?.settings()[0]?.config.planner).toEqual(planner);
  });

  it('builds nothing when the operator picks no preset', async () => {
    const presetSource = new InMemoryPresetSource();
    presetSource.put(0, presetName(), {});
    const { build, askForPreset, openSandboxRuntime, images } = await setup({ presetSource });

    const result = await build({ preset: { kind: 'ask' } });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(askForPreset).toHaveBeenCalledTimes(1);
    expect(openSandboxRuntime).not.toHaveBeenCalled();
    expect(images.build).not.toHaveBeenCalled();
  });

  it('refuses a named preset nobody defined without asking or building anything', async () => {
    const presetSource = new InMemoryPresetSource();
    presetSource.put(0, presetName(), {});
    const { build, askForPreset, openSandboxRuntime, images } = await setup({ presetSource });

    const result = await build({ preset: { kind: 'named', name: presetName() } });

    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(askForPreset).not.toHaveBeenCalled();
    expect(openSandboxRuntime).not.toHaveBeenCalled();
    expect(images.build).not.toHaveBeenCalled();
  });

  it('refuses a directory below the repository root before building anything', async () => {
    const { build, openSandboxRuntime } = await setup({ startInSubdirectory: true });

    const result = await build();

    expect(result.isErr() && result.error).toBeInstanceOf(RepositoryInvalid);
    expect(openSandboxRuntime).not.toHaveBeenCalled();
  });

  async function setup(input: {
    config?: Record<string, unknown>;
    buildFailure?: ImageBuildFailed;
    presetSource?: InMemoryPresetSource;
    startInSubdirectory?: boolean;
  }) {
    const repo = { dir: await tempDirectory('jig-repo-') };
    const config = { ...everyStepOn(), ...input.config };
    await writeFile(path.join(repo.dir, 'jig.config.json'), JSON.stringify(config));
    await mkdir(path.join(repo.dir, SANDBOX_DIRECTORY));
    await writeFile(path.join(repo.dir, SANDBOX_DIRECTORY, DOCKERFILE), BASE_DOCKERFILE);
    const images = mock<SandboxImages>({
      labels: vi.fn().mockResolvedValue(Result.ok(undefined)),
      build: vi
        .fn()
        .mockResolvedValue(input.buildFailure ? Result.err(input.buildFailure) : Result.ok()),
    });
    const latestVersions = vi.fn(async (packages: string[]) =>
      Object.fromEntries(packages.map((npmPackage) => [npmPackage, faker.system.semver()])),
    );
    const built: ReturnType<typeof localSandboxRuntime>[] = [];
    const openSandboxRuntime = vi.fn((request: RuntimeRequest) => {
      const runtime = localSandboxRuntime(request, {
        images,
        latestVersions,
        open: vi.fn(),
        log: mock<OperationLog>(),
      });
      built.push(runtime);
      return runtime.runtime;
    });
    const askForPreset = vi.fn(async () => undefined);
    const sources = repositorySourcesAt(repo.dir, {
      presetSourceFor: () => input.presetSource ?? new InMemoryPresetSource(),
    });
    const cwd = input.startInSubdirectory ? path.join(repo.dir, faker.word.noun()) : repo.dir;
    if (input.startInSubdirectory) await mkdir(cwd);
    return {
      repoRoot: repo.dir,
      images,
      latestVersions,
      openSandboxRuntime,
      askForPreset,
      runtimes: () => built,
      build: (options: Omit<BuildImageInput, 'logFormat'> = {}) =>
        buildSandboxImage(
          {
            ...sources,
            context: () => operationContextIn(cwd),
            openSandboxRuntime,
            askForPreset,
          },
          { ...options, logFormat: 'json' },
        ),
    };
  }
});
