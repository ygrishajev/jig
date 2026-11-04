import type { AwilixContainer } from 'awilix';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { refuseSymlinks } from '../adapters/find-symlink.js';
import {
  BASE_DOCKERFILE,
  DOCKERFILE,
  SANDBOX_DIRECTORY,
  withToolchain,
} from '../adapters/sandbox-image/image-recipe.js';
import {
  ignoreSandcastleDirectory,
  type SessionCloseFailure,
  type SessionOpenFailure,
} from '../adapters/sandcastle/sandcastle-session.js';
import { CONFIG_FILE, loadConfig } from '../config/load-config.js';
import { updateConfigFile } from '../config/write-config.js';
import {
  type AgentOutputInvalid,
  type AgentRunFailed,
  ConfigInvalid,
  type GitCommandFailed,
  type ImageBuildFailed,
  messageOf,
  SetupCommandFailed,
} from '../domain/errors.js';
import { toolchainPrompt } from '../prompts/toolchain.js';
import { type AppCradle, type RunSession, withThrowawaySandbox } from './container.js';
import { ensureSandboxImage, readSandboxDockerfile } from './sandbox-image.js';

export type InitResult =
  | { status: 'verified'; attempts: number }
  | { status: 'failed'; attempts: number; failure: string }
  | { status: 'written' };

export type InitFailure = SandboxCheckFailure | AgentRunFailed | AgentOutputInvalid;

/** Why a throwaway sandbox gave no answer: the image, Docker, git, or the sandbox's own cleanup. */
export type SandboxCheckFailure =
  ConfigInvalid | ImageBuildFailed | SessionOpenFailure | SessionCloseFailure | GitCommandFailed;

/**
 * Writes the sandbox Dockerfile and a starter config if the repository has none. With an agent,
 * the planner then fills in the project's toolchain and setup and verify commands, and the
 * result counts only once both commands pass inside the built sandbox — a failure goes back to
 * the planner. Without an agent, the commands already configured are checked.
 */
export function initSandbox(
  app: AwilixContainer<AppCradle>,
  options: { useAgent: boolean },
): Promise<Result<InitResult, InitFailure>> {
  return Result.gen(async function* () {
    const { repoRoot } = app.cradle;
    yield* Result.await(writeStarterFiles(repoRoot));
    if (!options.useAgent) {
      const config = yield* loadConfig(repoRoot);
      if (!config.verifyCommand) return Result.ok<InitResult, InitFailure>({ status: 'written' });
      const failure = yield* Result.await(
        checkInSandbox(app, config.setupCommand, config.verifyCommand),
      );
      return Result.ok<InitResult, InitFailure>(
        failure ? { status: 'failed', attempts: 1, failure } : { status: 'verified', attempts: 1 },
      );
    }

    let previousFailure: string | undefined;
    for (let attempt = 1; attempt <= TOOLCHAIN_ATTEMPTS; attempt++) {
      const proposal = yield* Result.await(proposeToolchain(app, previousFailure));
      yield* Result.await(writeToolchain(repoRoot, proposal.toolchain));
      yield* Result.await(
        updateConfigFile(repoRoot, {
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

async function writeStarterFiles(repoRoot: string): Promise<Result<void, ConfigInvalid>> {
  const ignored = await ignoreSandcastleDirectory(repoRoot);
  if (ignored.isErr()) return ignored;
  const dockerfile = path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE);
  const config = path.join(repoRoot, CONFIG_FILE);
  const refused = refuseSymlinks([dockerfile, config]);
  if (refused.isErr()) return refused;
  const written = await writeIfMissing(dockerfile, BASE_DOCKERFILE);
  if (written.isErr()) return written;
  return writeIfMissing(config, '{}\n');
}

function writeIfMissing(file: string, contents: string): Promise<Result<void, ConfigInvalid>> {
  return existsSync(file) ? Promise.resolve(Result.ok()) : writeRepoFile(file, contents);
}

function writeRepoFile(file: string, contents: string): Promise<Result<void, ConfigInvalid>> {
  return Result.tryPromise({
    try: () => writeFile(file, contents),
    catch: (cause) =>
      new ConfigInvalid({ message: `Could not write ${file}: ${messageOf(cause)}` }),
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
): Promise<Result<z.infer<typeof toolchainSchema>, InitFailure>> {
  return Result.gen(async function* () {
    const { repoRoot } = app.cradle;
    const config = yield* loadConfig(repoRoot);
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
): Promise<Result<void, ConfigInvalid>> {
  const dockerfile = await readSandboxDockerfile(repoRoot);
  const filled = dockerfile.andThen((contents) => withToolchain(contents, toolchain));
  if (filled.isErr()) return Result.err(filled.error);
  return writeRepoFile(path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE), filled.value);
}
