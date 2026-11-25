import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { aJigConfig, everyStepOn, runId, runSettings } from '../../tests/support/builders.js';
import {
  FakeAgentSession,
  InMemoryConfigSource,
  InMemoryPresetSource,
  InMemoryRunStore,
} from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { parseEnvironment } from '../config/environment.js';
import type { JigConfig } from '../config/load-config.js';
import type { RunEvent } from '../domain/events.js';
import type { RunTelemetry } from '../ports/observability.js';
import type { SandboxImages } from '../ports/sandbox-images.js';
import { runRuntimeFactory } from './run-runtime.js';
import type { RuntimeWiring } from './runtime-wiring.js';

describe('runRuntimeFactory', () => {
  it('opens no sandbox, image or run log until the run asks for one', async () => {
    const { openRuntime, openSession, images, repoRoot } = await setup({});

    openRuntime();

    expect(openSession).not.toHaveBeenCalled();
    expect(images).not.toHaveBeenCalled();
    expect(existsSync(path.join(repoRoot, '.jig'))).toBe(false);
  });

  it('logs the run and opens its sandbox over one console log', async () => {
    const { openRuntime, openSession, consoleLog } = await setup({});
    const { run } = openRuntime();

    unwrap(await run.sandbox.openScope(aRun(), new InMemoryRunStore(), undefined));

    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0]?.[0].logger).toBe(run.log);
  });

  it('opens the sandbox with the config and environment the runtime was opened with', async () => {
    const sandboxImage = faker.word.noun();
    const { openRuntime, openSession, request } = await setup({ config: { sandboxImage } });

    unwrap(await openRuntime().run.sandbox.openScope(aRun(), new InMemoryRunStore(), undefined));

    expect(openSession.mock.calls[0]?.[0]).toMatchObject({
      config: request.config,
      environment: request.environment,
      imageName: sandboxImage,
    });
  });

  it('refuses a step whose agent has no credential in the environment it was opened with', async () => {
    const { openRuntime } = await setup({ environment: {} });

    expect(openRuntime().run.sandbox.checkCredentials().isErr()).toBe(true);
  });

  it('runs the engine under the settings resolved from the config it was opened with', async () => {
    const settings = runSettings({ maxStepRetries: faker.number.int({ min: 0, max: 5 }) });
    const resolve = vi.fn(() => settings);
    const { openRuntime, request } = await setup({ runSettings: resolve });

    const scope = unwrap(
      await openRuntime().run.sandbox.openScope(aRun(), new InMemoryRunStore(), undefined),
    );

    expect(resolve).toHaveBeenCalledWith(request.config);
    expect(scope.engineDependencies.settings).toBe(settings);
  });

  it('gives every run its own events and workspace', async () => {
    const { openRuntime } = await setup({});
    const { sandbox } = openRuntime().run;

    const first = unwrap(await sandbox.openScope(aRun(), new InMemoryRunStore(), undefined));
    const second = unwrap(await sandbox.openScope(aRun(), new InMemoryRunStore(), undefined));

    expect(second.engineDependencies.events).not.toBe(first.engineDependencies.events);
    expect(second.engineDependencies.ports.workspace).not.toBe(
      first.engineDependencies.ports.workspace,
    );
  });

  it("lets the run's telemetry hear the run's events until the scope is disposed", async () => {
    const { openRuntime } = await setup({});
    const heard = vi.fn<(event: RunEvent) => void>();
    const telemetry = mock<RunTelemetry>({ observer: { handle: heard } });
    const run = aRun();
    const scope = unwrap(
      await openRuntime().run.sandbox.openScope(run, new InMemoryRunStore(), telemetry),
    );
    const event: RunEvent = { type: 'runResumed', runId: run.runId, phase: 'context' };

    scope.engineDependencies.events.publish(event);
    await scope.dispose();
    scope.engineDependencies.events.publish(event);

    expect(heard.mock.calls).toEqual([[event]]);
  });

  async function setup(input: {
    config?: Partial<JigConfig>;
    environment?: NodeJS.ProcessEnv;
    runSettings?: RuntimeWiring['runSettings'];
  }) {
    const repoRoot = await tempDirectory('jig-run-runtime-');
    const session = () => new FakeAgentSession(repoRoot);
    const openSession = vi.fn<RuntimeWiring['openSession']>(async () => Result.ok(session()));
    const images = vi.fn((): SandboxImages => mock<SandboxImages>());
    const consoleLog = vi.fn((): Logger => mock<Logger>());
    const request = {
      repoRoot,
      logFormat: 'json' as const,
      environment: unwrap(
        parseEnvironment(
          input.environment ?? { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) },
          faker.system.directoryPath(),
        ),
      ),
      configSource: new InMemoryConfigSource(),
      config: aJigConfig({ ...everyStepOn(), ...input.config }),
      presetSource: new InMemoryPresetSource(),
    };
    const open = runRuntimeFactory({
      logLevel: 'silent',
      consoleLog,
      images,
      openSession,
      ...(input.runSettings && { runSettings: input.runSettings }),
    });
    return { openRuntime: () => open(request), openSession, images, consoleLog, request, repoRoot };
  }
});

function aRun() {
  return { runId: runId(), baseBranch: faker.git.branch() };
}
