import { configDestination } from '../adapters/filesystem/config-source.js';
import { RepositoryStarterFiles } from '../adapters/sandbox-image/starter-files.js';
import { RepositoryAgentCredentials } from '../adapters/sandcastle/agent-credentials.js';
import type { RuntimeRequest, SandboxRuntime } from '../app/api.js';
import {
  type ConsoleWiring,
  type ImageWiring,
  productionConsole,
  productionImages,
  productionSessions,
  sandboxCapabilities,
  type SessionWiring,
} from './runtime-wiring.js';

/** What `jig init` and `jig build` are built with: no run settings, since neither runs the engine. */
export type SandboxRuntimeWiring = ConsoleWiring & ImageWiring & SessionWiring;

/**
 * Opens what `jig init` and `jig build` work with over `wiring`. Every sandbox is built over the
 * config and environment it is asked for and shares the runtime's console log; nothing is built
 * for it until it is asked for.
 */
export function sandboxRuntimeFactory(
  overrides: Partial<SandboxRuntimeWiring> = {},
): (request: RuntimeRequest) => SandboxRuntime {
  const wiring: SandboxRuntimeWiring = {
    ...productionConsole,
    ...productionImages,
    ...productionSessions,
    ...overrides,
  };
  return (request) => openSandboxRuntime(wiring, request);
}

function openSandboxRuntime(
  wiring: SandboxRuntimeWiring,
  { repoRoot, configPath, logFormat }: RuntimeRequest,
): SandboxRuntime {
  const log = wiring.consoleLog(logFormat, wiring.logLevel);
  return {
    log,
    starterFiles: new RepositoryStarterFiles(repoRoot, configDestination(repoRoot, configPath)),
    credentials: new RepositoryAgentCredentials(repoRoot),
    sandboxFor: ({ config, environment }) =>
      sandboxCapabilities(wiring, { repoRoot, config, environment, log }),
    dispose: async () => {},
  };
}
