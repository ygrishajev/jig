import type { AwilixContainer } from 'awilix';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  BASE_DOCKERFILE,
  DOCKERFILE,
  SANDBOX_DIRECTORY,
  withToolchain,
} from '../adapters/sandbox-image/image-recipe.js';
import { ignoreSandcastleDirectory } from '../adapters/sandcastle/sandcastle-session.js';
import { CONFIG_FILE, loadConfig } from '../config/load-config.js';
import { updateConfigFile } from '../config/write-config.js';
import { SetupCommandFailed } from '../domain/errors.js';
import { runIdSchema } from '../domain/run-id.js';
import { runBranchFor } from '../domain/run-state.js';
import { getCurrentBranch } from '../git/branch.js';
import { openRepo } from '../git/repository.js';
import { LoggingObserver } from '../observers/logging-observer.js';
import { observe, RunEvents } from '../observers/run-events.js';
import { toolchainPrompt } from '../prompts/toolchain.js';
import type { AppCradle, RunIdentity } from './container.js';
import { ensureSandboxImage } from './sandbox-image.js';

/** How many times the planner gets to fix a toolchain that failed setup or verify. */
const TOOLCHAIN_ATTEMPTS = 3;

const toolchainSchema = z.object({
  toolchain: z.string(),
  setupCommand: z.string(),
  verifyCommand: z.string(),
});

export type InitResult =
  | { status: 'verified'; attempts: number }
  | { status: 'failed'; attempts: number; failure: string }
  | { status: 'written' };

/**
 * Writes the sandbox Dockerfile and a starter config if the repository has none. With an agent,
 * the planner then fills in the project's toolchain and setup and verify commands, and the
 * result counts only once both commands pass inside the built sandbox — a failure goes back to
 * the planner. Without an agent, the commands already configured are checked.
 */
export async function initSandbox(
  app: AwilixContainer<AppCradle>,
  options: { useAgent: boolean },
): Promise<InitResult> {
  const { repoRoot } = app.cradle;
  await writeStarterFiles(repoRoot);
  if (!options.useAgent) {
    const config = loadConfig(repoRoot);
    if (!config.verifyCommand) return { status: 'written' };
    const failure = await checkInSandbox(app, config.setupCommand, config.verifyCommand);
    return failure
      ? { status: 'failed', attempts: 1, failure }
      : { status: 'verified', attempts: 1 };
  }

  let previousFailure: string | undefined;
  for (let attempt = 1; attempt <= TOOLCHAIN_ATTEMPTS; attempt++) {
    const proposal = await proposeToolchain(app, previousFailure);
    await writeToolchain(repoRoot, proposal.toolchain);
    await updateConfigFile(repoRoot, {
      setupCommand: proposal.setupCommand,
      verifyCommand: proposal.verifyCommand,
    });
    previousFailure = await checkInSandbox(app, proposal.setupCommand, proposal.verifyCommand);
    if (!previousFailure) return { status: 'verified', attempts: attempt };
    app.cradle.logger.warn(`attempt ${attempt} did not pass in the sandbox`);
  }
  return { status: 'failed', attempts: TOOLCHAIN_ATTEMPTS, failure: previousFailure ?? '' };
}

async function writeStarterFiles(repoRoot: string) {
  const directory = path.join(repoRoot, SANDBOX_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeIfMissing(path.join(directory, DOCKERFILE), BASE_DOCKERFILE);
  await ignoreSandcastleDirectory(repoRoot);
  await writeIfMissing(path.join(repoRoot, CONFIG_FILE), '{}\n');
}

async function writeIfMissing(file: string, contents: string) {
  if (!existsSync(file)) await writeFile(file, contents);
}

async function writeToolchain(repoRoot: string, toolchain: string) {
  const file = path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE);
  await writeFile(file, withToolchain(await readFile(file, 'utf-8'), toolchain));
}

async function proposeToolchain(app: AwilixContainer<AppCradle>, previousFailure?: string) {
  const { repoRoot } = app.cradle;
  const config = loadConfig(repoRoot);
  const dockerfile = await readFile(path.join(repoRoot, SANDBOX_DIRECTORY, DOCKERFILE), 'utf-8');
  return withSandbox(app, null, (session) =>
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
  );
}

/**
 * Rebuilds the image and runs both commands in a fresh sandbox; returns how either command
 * failed, if one did. Anything else — Docker, credentials — is not the toolchain's fault and is
 * thrown, rather than spending the planner's attempts on it.
 */
async function checkInSandbox(
  app: AwilixContainer<AppCradle>,
  setupCommand: string | undefined,
  verifyCommand: string,
) {
  try {
    return await withSandbox(app, setupCommand ?? null, async (session) => {
      const verify = await session.exec(verifyCommand);
      return verify.exitCode === 0
        ? undefined
        : `verifyCommand "${verifyCommand}" exited with ${verify.exitCode}:\n${verify.output.slice(-3000)}`;
    });
  } catch (error) {
    if (error instanceof SetupCommandFailed) return error.message;
    throw error;
  }
}

/** A throwaway sandbox on its own branch, removed again afterwards. */
async function withSandbox<T>(
  app: AwilixContainer<AppCradle>,
  setupCommand: string | null,
  use: (session: Awaited<ReturnType<AppCradle['openSession']>>) => Promise<T>,
) {
  const { repoRoot, logger } = app.cradle;
  await ensureSandboxImage(app.cradle);
  const run: RunIdentity = {
    runId: runIdSchema.parse(`init-${randomBytes(3).toString('hex')}`),
    baseBranch: await getCurrentBranch(repoRoot),
  };
  const events = new RunEvents();
  const logging = new LoggingObserver(logger);
  observe(
    events,
    (event) => logging.handle(event),
    () => undefined,
  );
  const session = await app.cradle.openSession({ run, events, setupCommand });
  try {
    return await use(session);
  } finally {
    await session.close();
    await openRepo(repoRoot)
      .raw(['branch', '-D', runBranchFor(run.runId)])
      .catch(() => undefined);
  }
}
