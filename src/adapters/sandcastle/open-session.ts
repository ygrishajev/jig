import type { AgentProvider } from '@ai-hero/sandcastle';
import type { Logger } from 'pino';

import type { JigEnvironment } from '../../config/environment.js';
import { configuredSteps, type JigConfig } from '../../config/load-config.js';
import { type AgentRole, byRole } from '../../domain/agent-role.js';
import type { RunIdentity } from '../../domain/run-state.js';
import type { EventSink } from '../../ports/observability.js';
import { agentLogFile } from '../local-store/run-paths.js';
import { sandboxTelemetryEnvironment } from '../telemetry/open-telemetry.js';
import { AGENTS, collectCredentials } from './agents.js';
import { sandcastleEnvKeys } from './sandcastle-env.js';
import { SandcastleSession, type SandcastleSessionOptions } from './sandcastle-session.js';

export interface OpenSessionInput {
  run: RunIdentity;
  events: EventSink;
  /** Overrides the configured setup command; `null` starts the sandbox without one. */
  setupCommand?: string | null;
}

/** What every sandbox of this repository is started from; `imageName` is the one to run. */
export interface SandcastleContext {
  repoRoot: string;
  config: JigConfig;
  environment: JigEnvironment;
  imageName: string;
}

/** Starts a sandbox for `input.run`, warning first about variables `.sandcastle/.env` adds to it. */
export async function openSandcastleSession(
  context: SandcastleContext & { logger: Logger },
  input: OpenSessionInput,
): Promise<SandcastleSession> {
  await warnWhenSandcastleEnvAddsVariables(context.repoRoot, context.logger);
  return SandcastleSession.open(sandcastleSessionOptions(context, input));
}

/** jig passes credentials from the environment; a variable from `.sandcastle/.env` is usually a mistake. */
export async function warnWhenSandcastleEnvAddsVariables(
  repoRoot: string,
  logger: Logger,
): Promise<void> {
  const injected = await sandcastleEnvKeys(repoRoot);
  if (injected.length === 0) return;
  logger.warn(
    `.sandcastle/.env also puts ${injected.join(', ')} into the sandbox — jig passes credentials from the environment; remove the file unless the agents need these`,
  );
}

/** What the run's sandbox is started with: the configured agents, their credentials and limits. */
export function sandcastleSessionOptions(
  { repoRoot, config, environment, imageName }: SandcastleContext,
  { run, events, setupCommand }: OpenSessionInput,
): SandcastleSessionOptions {
  const steps = configuredSteps(config);
  return {
    repoRoot,
    ...run,
    imageName,
    codexAuthDirectory: Object.values(steps).some((step) => step.provider === 'codex')
      ? environment.codexAuthDirectory
      : undefined,
    credentials: {
      ...collectCredentials(Object.values(steps), environment.credential),
      ...sandboxTelemetryEnvironment(environment.telemetry),
    },
    agents: agentsFor(steps),
    skipCommitSigning: config.commitSigning === 'skip',
    setupCommand: setupCommand === null ? undefined : (setupCommand ?? config.setupCommand),
    setupTimeoutSeconds: config.setupTimeoutSeconds,
    idleTimeoutSeconds: config.agentIdleTimeoutSeconds,
    agentLogFile: agentLogFile(repoRoot, run.runId),
    events,
  };
}

function agentsFor(steps: ReturnType<typeof configuredSteps>): Record<AgentRole, AgentProvider> {
  return byRole((role) => AGENTS[steps[role].provider].create(steps[role].model));
}
