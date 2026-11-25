import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aJigConfig, runId } from '../../tests/support/builders.js';
import {
  FakeAgentSession,
  InMemoryConfigSource,
  InMemoryPresetSource,
} from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { parseEnvironment } from '../config/environment.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import { sandboxRuntimeFactory, type SandboxRuntimeWiring } from './sandbox-runtime.js';

describe('sandboxRuntimeFactory', () => {
  it('builds each sandbox over the config it is given, not the one the runtime opened with', async () => {
    const { runtime } = await setup();
    const config = aJigConfig({ sandboxImage: faker.word.noun() });

    const sandbox = runtime.sandboxFor({ config, environment: anEnvironment() });

    expect(sandbox.image.config).toBe(config);
    expect(sandbox.image.recipe.image).toBe(config.sandboxImage);
  });

  it('opens each throwaway sandbox with the config and environment that sandbox was built for', async () => {
    const { runtime, openSession } = await setup();
    const first = { config: aJigConfig(), environment: anEnvironment() };
    const second = { config: aJigConfig(), environment: anEnvironment() };
    const firstSandbox = runtime.sandboxFor(first);
    runtime.sandboxFor(second);

    await firstSandbox.throwaway.open(aRun(), null);

    expect(openSession.mock.calls[0]?.[0]).toMatchObject(first);
    expect(openSession.mock.calls[0]?.[1].setupCommand).toBeNull();
  });

  it('shares one console log across the runtime and every sandbox', async () => {
    const { runtime, consoleLog, openSession } = await setup();

    const first = runtime.sandboxFor({ config: aJigConfig(), environment: anEnvironment() });
    const second = runtime.sandboxFor({ config: aJigConfig(), environment: anEnvironment() });
    await second.throwaway.open(aRun(), null);

    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect([first.image.log, second.image.log, second.throwaway.log]).toEqual([
      runtime.log,
      runtime.log,
      runtime.log,
    ]);
    expect(openSession.mock.calls[0]?.[0].logger).toBe(runtime.log);
  });

  it('opens no sandbox and asks nothing of the images until a sandbox is used', async () => {
    const { runtime, openSession, images } = await setup();

    runtime.sandboxFor({ config: aJigConfig(), environment: anEnvironment() });

    expect(openSession).not.toHaveBeenCalled();
    expect(images.labels).not.toHaveBeenCalled();
    expect(images.build).not.toHaveBeenCalled();
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-sandbox-runtime-');
    const openSession = vi.fn<SandboxRuntimeWiring['openSession']>(async () =>
      Result.ok(new FakeAgentSession(repoRoot)),
    );
    const images = mock<SandboxImages>();
    const consoleLog = vi.fn((): Logger => mock<Logger>());
    const open = sandboxRuntimeFactory({
      logLevel: 'silent',
      consoleLog,
      images: () => images,
      openSession,
    });
    const runtime = open({
      repoRoot,
      logFormat: 'json',
      environment: anEnvironment(),
      configSource: new InMemoryConfigSource(),
      config: aJigConfig(),
      presetSource: new InMemoryPresetSource(),
    });
    return { runtime, openSession, images, consoleLog };
  }
});

function anEnvironment() {
  return unwrap(
    parseEnvironment(
      { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) },
      faker.system.directoryPath(),
    ),
  );
}

function aRun() {
  return { runId: runId(), baseBranch: faker.git.branch() };
}
