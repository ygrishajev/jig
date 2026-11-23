import type { AgentProvider } from '@ai-hero/sandcastle';
import { Result } from 'better-result';
import type { Logger } from 'pino';

import type { JigEnvironment } from '../../config/environment.js';
import type { ConfigInvalid } from '../../config/errors.js';
import { configuredSteps, type JigConfig, type StepConfig } from '../../config/load-config.js';
import type { AgentRole } from '../../domain/agent-role.js';
import type { RunIdentity } from '../../domain/run-state.js';
import type { CredentialsInvalid } from '../../ports/credentials.js';
import type { EventSink } from '../../ports/observability.js';
import type { SessionOpenFailure } from '../../ports/sandbox.js';
import { agentLogFile } from '../local-store/run-paths.js';
import { sandboxTelemetryEnvironment } from '../telemetry/open-telemetry.js';
import { AGENTS, collectCredentials } from './agents.js';
import { sandcastleEnvKeys } from './sandcastle-env.js';
import { SandcastleSession, type SandcastleSessionOptions } from './sandcastle-session.js';

export type OpenSessionFailure = ConfigInvalid | SessionOpenFailure;

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
): Promise<Result<SandcastleSession, OpenSessionFailure>> {
  await warnWhenSandcastleEnvAddsVariables(context.repoRoot, context.logger);
  const options = sandcastleSessionOptions(context, input);
  if (options.isErr()) return Result.err(options.error);
  return SandcastleSession.open(options.value);
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
  { repoRoot, config, environment, imageName, logger }: SandcastleContext & { logger: Logger },
  { run, events, setupCommand }: OpenSessionInput,
): Result<SandcastleSessionOptions, ConfigInvalid | CredentialsInvalid> {
  const configured = configuredSteps(config);
  if (configured.isErr()) return Result.err(configured.error);
  const steps = configured.value;
  const credentials = stepCredentials(config, environment);
  if (credentials.isErr()) return Result.err(credentials.error);
  const agents = agentsFor(steps);
  if (agents.isErr()) return Result.err(agents.error);
  return Result.ok({
    repoRoot,
    ...run,
    imageName,
    codexAuthDirectory: Object.values(steps).some((step) => step.provider === 'codex')
      ? environment.codexAuthDirectory
      : undefined,
    credentials: {
      ...credentials.value,
      ...sandboxTelemetryEnvironment(environment.telemetry),
    },
    agents: agents.value,
    setupCommand: setupCommand === null ? undefined : (setupCommand ?? config.setupCommand),
    setupTimeoutSeconds: config.setupTimeoutSeconds,
    idleTimeoutSeconds: config.agentIdleTimeoutSeconds,
    agentLogFile: agentLogFile(repoRoot, run.runId),
    events,
    logger,
  });
}

/** The credentials of every step's agent; fails naming what to set when one has none. */
export function stepCredentials(
  config: JigConfig,
  environment: JigEnvironment,
): Result<Record<string, string>, ConfigInvalid | CredentialsInvalid> {
  return configuredSteps(config).andThen((steps) =>
    collectCredentials(Object.values(steps), environment.credential),
  );
}

function agentsFor(
  steps: Record<AgentRole, StepConfig>,
): Result<Record<AgentRole, AgentProvider>, ConfigInvalid> {
  return Result.gen(function* () {
    const planner = yield* AGENTS[steps.planner.provider].create(steps.planner.model);
    const implementer = yield* AGENTS[steps.implementer.provider].create(steps.implementer.model);
    const reviewer = yield* AGENTS[steps.reviewer.provider].create(steps.reviewer.model);
    const describer = yield* AGENTS[steps.describer.provider].create(steps.describer.model);
    return Result.ok({ planner, implementer, reviewer, describer });
  });
}
