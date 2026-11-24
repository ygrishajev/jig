import { Result } from 'better-result';
import { z } from 'zod';

import type { LogFormat } from '../adapters/logging/create-logger.js';
import type { AgentChoice, EnteredCredential, MissingCredential } from '../config/agent-policy.js';
import type { ConfigSource } from '../config/config-source.js';
import { type JigEnvironment, withCredentials } from '../config/environment.js';
import type { ConfigInvalid } from '../config/errors.js';
import {
  configuredSteps,
  type JigConfig,
  loadConfig,
  type StepConfig,
  stepsWithoutAgent,
} from '../config/load-config.js';
import { updateConfig } from '../config/update-config.js';
import type { AgentRole } from '../domain/agent-role.js';
import {
  type AgentOutputInvalid,
  type AgentRunFailed,
  type SandboxCredentialsInvalid,
  type SandboxPreparationInvalid,
  SetupCommandFailed,
} from '../ports/agent-session.js';
import type { LocalPreparationFailed, LocalStateUnwritable } from '../ports/local-state.js';
import type { RunSession } from '../ports/run-session.js';
import type { ImageBuildFailed } from '../ports/sandbox-images.js';
import type { StarterFiles } from '../ports/starter-files.js';
import { toolchainPrompt } from '../prompts/toolchain.js';
import { disposableLifetime, withResource } from './lifecycle.js';
import {
  type PreparedRepository,
  prepareRepository,
  type RepositoryPreparationFailure,
} from './repository-preparation.js';
import { ensureSandboxImage } from './sandbox-image.js';
import type {
  SandboxCapabilities,
  SandboxOperationCapabilities,
  SandboxRuntime,
} from './sandbox-runtime.js';
import { type ThrowawaySandboxFailure, withThrowawaySandbox } from './throwaway-sandbox.js';

export interface InitInput {
  /** With an agent, the planner fills in the toolchain; without one, only the configured commands are checked. */
  useAgent: boolean;
  /** A config file other than the repository's own, relative to its root. */
  configPath?: string;
  logFormat: LogFormat;
}

/** How init ended, and the name of the config it wrote, for telling the operator what to commit. */
export interface InitReport {
  outcome: InitResult;
  configName: string;
}

export type InitResult =
  | { status: 'verified'; attempts: number }
  | { status: 'failed'; attempts: number; failure: string }
  | { status: 'written' }
  | { status: 'needs-agents'; instruction: string };

export type InitCapabilities = SandboxOperationCapabilities & InitInteraction;

/** The questions init asks the operator; nobody answering is `undefined`. */
export interface InitInteraction {
  askForAgents(roles: AgentRole[]): Promise<Partial<Record<AgentRole, AgentChoice>> | undefined>;
  askForCredential(missing: MissingCredential): Promise<EnteredCredential | undefined>;
}

export type InitFailure =
  | RepositoryPreparationFailure
  | SandboxCheckFailure
  | AgentRunFailed
  | AgentOutputInvalid
  | LocalStateUnwritable;

/** Why a throwaway sandbox gave no answer: the image, Docker, git, or the sandbox's own cleanup. */
export type SandboxCheckFailure =
  | ThrowawaySandboxFailure
  | LocalPreparationFailed
  | SandboxPreparationInvalid
  | ImageBuildFailed
  | ConfigInvalid
  | SandboxCredentialsInvalid;

interface InitContext {
  runtime: SandboxRuntime;
  interaction: InitInteraction;
  prepared: PreparedRepository;
  useAgent: boolean;
}

interface CredentialRequest {
  runtime: Pick<SandboxRuntime, 'credentials' | 'sandboxFor'>;
  interaction: InitInteraction;
  steps: StepConfig[];
  environment: JigEnvironment;
}

/**
 * Writes the sandbox Dockerfile and a starter config if the repository has none, and asks which
 * agents to use for steps without one; with none chosen, it stops there and says what to set. It
 * then asks for credentials those agents lack, saving each only when the operator agrees. With an
 * agent, the planner fills in the project's toolchain and setup and verify commands, and the
 * result counts only once both commands pass inside the built sandbox — a failure goes back to
 * the planner. Without an agent, the commands already configured are checked.
 */
export function initRepository(
  capabilities: InitCapabilities,
  { useAgent, configPath, logFormat }: InitInput,
): Promise<Result<InitReport, InitFailure>> {
  return Result.gen(async function* () {
    const prepared = yield* Result.await(
      prepareRepository(capabilities.context(), capabilities, configPath),
    );
    const runtime = capabilities.openSandboxRuntime({ ...prepared, configPath, logFormat });
    const outcome = yield* Result.await(
      withResource(disposableLifetime(runtime), runtime.log, (opened) =>
        initWith({ runtime: opened, interaction: capabilities, prepared, useAgent }),
      ),
    );
    return Result.ok({ outcome, configName: prepared.configSource.name });
  });
}

function initWith({
  runtime,
  interaction,
  prepared,
  useAgent,
}: InitContext): Promise<Result<InitResult, InitFailure>> {
  return Result.gen(async function* () {
    const { configSource, environment } = prepared;
    yield* Result.await(runtime.starterFiles.writeMissing());
    if (useAgent) yield* Result.await(chooseMissingAgents(configSource, interaction));
    const config = yield* loadConfig(configSource);
    const configured = configuredSteps(config);
    if (configured.isErr()) {
      return Result.ok<InitResult, InitFailure>({
        status: 'needs-agents',
        instruction: configured.error.message,
      });
    }
    const steps = Object.values(configured.value);
    const credentialRequest = { runtime, interaction, steps, environment };
    if (!useAgent) return checkConfiguredCommands(config, credentialRequest);
    const completed = yield* Result.await(ensureCredentials(credentialRequest));
    const sandbox = runtime.sandboxFor({ config, environment: completed });
    return proposeUntilVerified(sandbox, runtime, configSource);
  });
}

async function chooseMissingAgents(
  configSource: ConfigSource,
  interaction: InitInteraction,
): Promise<Result<void, ConfigInvalid>> {
  const config = loadConfig(configSource);
  if (config.isErr()) return Result.err(config.error);
  const missing = stepsWithoutAgent(config.value);
  if (missing.length === 0) return Result.ok();
  const agents = await interaction.askForAgents(missing);
  return agents ? updateConfig(configSource, agents) : Result.ok();
}

async function checkConfiguredCommands(
  config: JigConfig,
  request: CredentialRequest,
): Promise<Result<InitResult, InitFailure>> {
  const { verifyCommand, setupCommand } = config;
  if (!verifyCommand) return Result.ok({ status: 'written' });
  const completed = await ensureCredentials(request);
  if (completed.isErr()) return Result.err(completed.error);
  const sandbox = request.runtime.sandboxFor({ config, environment: completed.value });
  const checked = await checkInSandbox(sandbox, setupCommand, verifyCommand);
  return checked.map((failure) =>
    failure ? { status: 'failed', attempts: 1, failure } : { status: 'verified', attempts: 1 },
  );
}

/**
 * Asks for the credentials the configured agents lack, before anything is built for them. The
 * operator decides whether each is saved; either way it lasts for the rest of this command.
 */
function ensureCredentials({
  runtime: { credentials },
  interaction,
  steps,
  environment,
}: CredentialRequest): Promise<
  Result<
    JigEnvironment,
    ConfigInvalid | SandboxCredentialsInvalid | LocalPreparationFailed | LocalStateUnwritable
  >
> {
  return Result.gen(async function* () {
    const entered: Record<string, string> = {};
    for (const missing of yield* credentials.missing(steps, environment)) {
      const credential = await interaction.askForCredential(missing);
      if (!credential) break;
      entered[credential.name] = credential.value;
      if (credential.save) {
        yield* Result.await(credentials.save({ name: credential.name, value: credential.value }));
      }
    }
    const completed = withCredentials(environment, entered);
    yield* credentials.check(steps, completed);
    return Result.ok(completed);
  });
}

/**
 * Rebuilds the image and runs both commands in a fresh sandbox; returns how either command
 * failed, if one did. Anything else — Docker, credentials — is not the toolchain's fault and is
 * returned as the error, rather than spending the planner's attempts on it.
 */
async function checkInSandbox(
  sandbox: SandboxCapabilities,
  setupCommand: string | undefined,
  verifyCommand: string,
): Promise<Result<string | undefined, SandboxCheckFailure>> {
  const checked = await withSandbox(sandbox, setupCommand ?? null, async (session) => {
    const verify = await session.exec(verifyCommand);
    return verify.map(({ exitCode, output }) =>
      exitCode === 0
        ? undefined
        : `verifyCommand "${verifyCommand}" exited with ${exitCode}:\n${output.slice(-3000)}`,
    );
  });
  if (checked.isErr() && checked.error instanceof SetupCommandFailed) {
    return Result.ok(checked.error.message);
  }
  return checked;
}

async function withSandbox<T, E>(
  sandbox: SandboxCapabilities,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<Result<T, E | SandboxCheckFailure>> {
  const image = await ensureSandboxImage(sandbox.image);
  if (image.isErr()) return Result.err(image.error);
  return withThrowawaySandbox(sandbox.throwaway, setupCommand, use);
}

function proposeUntilVerified(
  sandbox: SandboxCapabilities,
  runtime: Pick<SandboxRuntime, 'starterFiles' | 'log'>,
  configSource: ConfigSource,
): Promise<Result<InitResult, InitFailure>> {
  return Result.gen(async function* () {
    let previousFailure: string | undefined;
    for (let attempt = 1; attempt <= TOOLCHAIN_ATTEMPTS; attempt++) {
      const proposal = yield* Result.await(
        proposeToolchain(sandbox, runtime.starterFiles, configSource, previousFailure),
      );
      yield* Result.await(runtime.starterFiles.writeToolchain(proposal.toolchain));
      yield* Result.await(
        updateConfig(configSource, {
          setupCommand: proposal.setupCommand,
          verifyCommand: proposal.verifyCommand,
        }),
      );
      previousFailure = yield* Result.await(
        checkInSandbox(sandbox, proposal.setupCommand, proposal.verifyCommand),
      );
      if (!previousFailure)
        return Result.ok<InitResult, InitFailure>({ status: 'verified', attempts: attempt });
      runtime.log.warn(`attempt ${attempt} did not pass in the sandbox`);
    }
    return Result.ok<InitResult, InitFailure>({
      status: 'failed',
      attempts: TOOLCHAIN_ATTEMPTS,
      failure: previousFailure ?? '',
    });
  });
}

/** How many times the planner gets to fix a toolchain that failed setup or verify. */
const TOOLCHAIN_ATTEMPTS = 3;

async function proposeToolchain(
  sandbox: SandboxCapabilities,
  starterFiles: StarterFiles,
  configSource: ConfigSource,
  previousFailure?: string,
): Promise<Result<z.infer<typeof toolchainSchema>, InitFailure>> {
  return Result.gen(async function* () {
    const config = yield* loadConfig(configSource);
    const dockerfile = yield* Result.await(starterFiles.readDockerfile());
    const proposed = yield* Result.await(
      withSandbox(sandbox, null, (session) =>
        session.runForOutput({
          role: 'planner',
          prompt: toolchainPrompt({
            dockerfile,
            setupCommand: config.setupCommand,
            verifyCommand: config.verifyCommand,
            previousFailure,
          }),
          schema: toolchainSchema,
        }),
      ),
    );
    return Result.ok(proposed);
  });
}

const toolchainSchema = z.object({
  toolchain: z.string(),
  setupCommand: z.string(),
  verifyCommand: z.string(),
});
