import { asValue, type AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { messageOf } from '../adapters/exception-details.js';
import type { ConfigDestination } from '../adapters/filesystem/config-source.js';
import { refuseSymlinks } from '../adapters/find-symlink.js';
import { saveCredential } from '../adapters/local-store/credentials-file.js';
import {
  BASE_DOCKERFILE,
  DOCKERFILE,
  SANDBOX_DIRECTORY,
  withToolchain,
} from '../adapters/sandbox-image/image-recipe.js';
import { collectCredentials, missingCredentials } from '../adapters/sandcastle/agents.js';
import { ignoreSandcastleDirectory } from '../adapters/sandcastle/sandcastle-session.js';
import { withCredentials } from '../config/environment.js';
import { ConfigInvalid } from '../config/errors.js';
import {
  configuredSteps,
  type JigConfig,
  loadConfig,
  type StepConfig,
  stepsWithoutAgent,
} from '../config/load-config.js';
import { updateConfig } from '../config/update-config.js';
import { type AgentOutputInvalid, type AgentRunFailed } from '../ports/agent-session.js';
import type { CredentialsInvalid } from '../ports/credentials.js';
import { FilesystemPreparationFailed, type LocalStateUnwritable } from '../ports/filesystem.js';
import { type GitCommandFailed, type RepositoryInvalid } from '../ports/git-failures.js';
import {
  type ImageBuildFailed,
  type ImageRecipeInvalid,
  type SessionCloseFailure,
  type SessionOpenFailure,
  SetupCommandFailed,
} from '../ports/sandbox.js';
import { toolchainPrompt } from '../prompts/toolchain.js';
import { type AppCradle, type RunSession } from './container.js';
import { ensureSandboxImage, readSandboxDockerfile } from './sandbox-image.js';
import { withThrowawaySandbox } from './throwaway-sandbox.js';

export type InitResult =
  | { status: 'verified'; attempts: number }
  | { status: 'failed'; attempts: number; failure: string }
  | { status: 'written' }
  | { status: 'needs-agents'; instruction: string };

export type InitFailure =
  SandboxCheckFailure | AgentRunFailed | AgentOutputInvalid | LocalStateUnwritable;

/** Why a throwaway sandbox gave no answer: the image, Docker, git, or the sandbox's own cleanup. */
export type SandboxCheckFailure =
  | ConfigInvalid
  | ImageRecipeInvalid
  | FilesystemPreparationFailed
  | CredentialsInvalid
  | ImageBuildFailed
  | SessionOpenFailure
  | SessionCloseFailure
  | GitCommandFailed
  | RepositoryInvalid;

/**
 * Writes the sandbox Dockerfile and a starter config if the repository has none, and asks which
 * agents to use for steps without one; with none chosen, it stops there and says what to set. It then
 * asks for credentials those agents lack. With an agent, the planner then fills in the project's toolchain and setup and verify commands, and the
 * result counts only once both commands pass inside the built sandbox — a failure goes back to
 * the planner. Without an agent, the commands already configured are checked.
 */
export function initSandbox(
  app: AwilixContainer<AppCradle>,
  options: { useAgent: boolean },
): Promise<Result<InitResult, InitFailure>> {
  return Result.gen(async function* () {
    const { repoRoot, configDestination, configSource } = app.cradle;
    yield* Result.await(writeStarterFiles(repoRoot, configDestination));
    if (options.useAgent) yield* Result.await(chooseMissingAgents(app));
    const config = yield* loadConfig(configSource);
    app.register({ config: asValue(config) });
    const steps = configuredSteps(config);
    if (steps.isErr()) {
      return Result.ok<InitResult, InitFailure>({
        status: 'needs-agents',
        instruction: steps.error.message,
      });
    }
    if (!options.useAgent) return checkConfiguredCommands(app, config, Object.values(steps.value));
    yield* Result.await(ensureCredentials(app, Object.values(steps.value)));

    let previousFailure: string | undefined;
    for (let attempt = 1; attempt <= TOOLCHAIN_ATTEMPTS; attempt++) {
      const proposal = yield* Result.await(proposeToolchain(app, previousFailure));
      yield* Result.await(writeToolchain(repoRoot, proposal.toolchain));
      yield* Result.await(
        updateConfig(configSource, {
          setupCommand: proposal.setupCommand,
          verifyCommand: proposal.verifyCommand,
        }),
      );
      previousFailure = yield* Result.await(
        checkInSandbox(app, proposal.setupCommand, proposal.verifyCommand),
      );
      if (!previousFailure)
        return Result.ok<InitResult, InitFailure>({ status: 'verified', attempts: attempt });
      app.cradle.logger.warn(`attempt ${attempt} did not pass in the sandbox`);
    }
    return Result.ok<InitResult, InitFailure>({
      status: 'failed',
      attempts: TOOLCHAIN_ATTEMPTS,
      failure: previousFailure ?? '',
    });
  });
}

async function writeStarterFiles(
  repoRoot: string,
  configDestination: ConfigDestination,
): Promise<Result<void, FilesystemPreparationFailed>> {
  const ignored = await ignoreSandcastleDirectory(repoRoot);
  if (ignored.isErr()) return ignored;
  const dockerfile = path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE);
  const config = configDestination.path;
  const refused = refuseSymlinks([dockerfile, config]);
  if (refused.isErr()) return refused;
  const written = await writeIfMissing(dockerfile, BASE_DOCKERFILE);
  if (written.isErr()) return written;
  return writeIfMissing(config, '{}\n');
}

function writeIfMissing(
  file: string,
  contents: string,
): Promise<Result<void, FilesystemPreparationFailed>> {
  return existsSync(file) ? Promise.resolve(Result.ok()) : writeRepoFile(file, contents);
}

function writeRepoFile(
  file: string,
  contents: string,
): Promise<Result<void, FilesystemPreparationFailed>> {
  return Result.tryPromise({
    try: () => writeFile(file, contents),
    catch: (cause) =>
      new FilesystemPreparationFailed({ message: `Could not write ${file}: ${messageOf(cause)}` }),
  });
}

async function chooseMissingAgents(
  app: AwilixContainer<AppCradle>,
): Promise<Result<void, ConfigInvalid>> {
  const { configSource, askForAgents } = app.cradle;
  const config = loadConfig(configSource);
  if (config.isErr()) return Result.err(config.error);
  const missing = stepsWithoutAgent(config.value);
  if (missing.length === 0) return Result.ok();
  const agents = await askForAgents(missing);
  return agents ? updateConfig(configSource, agents) : Result.ok();
}

async function checkConfiguredCommands(
  app: AwilixContainer<AppCradle>,
  config: JigConfig,
  steps: StepConfig[],
): Promise<Result<InitResult, SandboxCheckFailure | LocalStateUnwritable>> {
  const { verifyCommand, setupCommand } = config;
  if (!verifyCommand) return Result.ok({ status: 'written' });
  const credentials = await ensureCredentials(app, steps);
  if (credentials.isErr()) return Result.err(credentials.error);
  const checked = await checkInSandbox(app, setupCommand, verifyCommand);
  return checked.map((failure) =>
    failure ? { status: 'failed', attempts: 1, failure } : { status: 'verified', attempts: 1 },
  );
}

/**
 * Asks for the credentials the configured agents lack, before anything is built for them. The
 * operator decides whether each is saved; either way it lasts for the rest of this command.
 */
async function ensureCredentials(
  app: AwilixContainer<AppCradle>,
  steps: StepConfig[],
): Promise<
  Result<
    void,
    ConfigInvalid | CredentialsInvalid | FilesystemPreparationFailed | LocalStateUnwritable
  >
> {
  return Result.gen(async function* () {
    const { repoRoot, environment, askForCredential } = app.cradle;
    const entered: Record<string, string> = {};
    for (const missing of yield* missingCredentials(steps, environment.credential)) {
      const credential = await askForCredential(missing);
      if (!credential) break;
      entered[credential.name] = credential.value;
      if (credential.save) {
        yield* Result.await(saveCredential(repoRoot, credential.name, credential.value));
      }
    }
    const completed = withCredentials(environment, entered);
    app.register({ environment: asValue(completed) });
    yield* collectCredentials(steps, completed.credential);
    return Result.ok();
  });
}

/**
 * Rebuilds the image and runs both commands in a fresh sandbox; returns how either command
 * failed, if one did. Anything else — Docker, credentials — is not the toolchain's fault and is
 * returned as the error, rather than spending the planner's attempts on it.
 */
async function checkInSandbox(
  app: AwilixContainer<AppCradle>,
  setupCommand: string | undefined,
  verifyCommand: string,
): Promise<Result<string | undefined, SandboxCheckFailure>> {
  const checked = await withSandbox(app, setupCommand ?? null, async (session) => {
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
  app: AwilixContainer<AppCradle>,
  setupCommand: string | null,
  use: (session: RunSession) => Promise<Result<T, E>>,
): Promise<Result<T, E | SandboxCheckFailure>> {
  const image = await ensureSandboxImage(app.cradle);
  if (image.isErr()) return Result.err(image.error);
  return withThrowawaySandbox(app, setupCommand, use);
}

/** How many times the planner gets to fix a toolchain that failed setup or verify. */
const TOOLCHAIN_ATTEMPTS = 3;

async function proposeToolchain(
  app: AwilixContainer<AppCradle>,
  previousFailure?: string,
): Promise<
  Result<z.infer<typeof toolchainSchema>, SandboxCheckFailure | AgentRunFailed | AgentOutputInvalid>
> {
  return Result.gen(async function* () {
    const { repoRoot, configSource } = app.cradle;
    const config = yield* loadConfig(configSource);
    const dockerfile = yield* Result.await(readSandboxDockerfile(repoRoot));
    const proposed = yield* Result.await(
      withSandbox(app, null, (session) =>
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

async function writeToolchain(
  repoRoot: string,
  toolchain: string,
): Promise<Result<void, ImageRecipeInvalid | FilesystemPreparationFailed>> {
  const dockerfile = await readSandboxDockerfile(repoRoot);
  const filled = dockerfile.andThen((contents) => withToolchain(contents, toolchain));
  if (filled.isErr()) return Result.err(filled.error);
  return writeRepoFile(path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE), filled.value);
}
