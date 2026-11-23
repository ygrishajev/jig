import {
  type AgentProvider,
  type AgentStreamEvent,
  createSandbox,
  type CreateSandboxOptions,
  type ExecResult as SandboxExecResult,
  type Sandbox,
} from '@ai-hero/sandcastle';
import { Result } from 'better-result';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from 'pino';
import { z, type ZodType } from 'zod';

import {
  AgentOutputInvalid,
  AgentRunFailed,
  type CodexLoginNotSaved,
  ConfigInvalid,
  type GitCommandFailed,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { messageOf } from '../../failures/messages.js';
import type {
  AgentRole,
  AgentRunInput,
  AgentSession,
  ExecResult,
} from '../../ports/agent-session.js';
import type { EventSink } from '../../ports/observability.js';
import type { SandboxGit } from '../../ports/sandbox-git.js';
import { refuseSymlinks } from '../find-symlink.js';
import { type CodexAuthCache, openCodexAuthCache } from './codex-auth.js';
import { hookManagerOf } from './git-hooks.js';
import { type PrivateClone, privateCloneDocker, shellQuote } from './private-clone-docker.js';
import { extractOutput, OUTPUT_TAG, outputInstruction } from './structured-output.js';
import { usageFromStreamLine } from './usage.js';

/** Why a sandbox did not open; `ConfigInvalid` is the operator's to fix, the others may pass. */
export type SessionOpenFailure = ConfigInvalid | SandboxUnavailable | SetupCommandFailed;

/** Why a sandbox did not close cleanly: the container would not stop, or the login was not handed back. */
export type SessionCloseFailure = SandboxUnavailable | CodexLoginNotSaved;

export type SandboxFactory = (options: CreateSandboxOptions) => Promise<Sandbox>;

export interface SandcastleSessionOptions {
  repoRoot: string;
  runId: RunId;
  baseBranch: string;
  imageName: string;
  credentials: Record<string, string>;
  codexAuthDirectory?: string;
  agents: Record<AgentRole, AgentProvider>;
  /** Runs once inside the sandbox before any agent, e.g. `npm ci`. */
  setupCommand?: string;
  setupTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  agentLogFile: string;
  events: EventSink;
  logger: Logger;
}

/** A command that prepares the sandbox before any agent runs, named the way a failure reports it. */
interface SetupStep {
  name: string;
  command: string;
}

/**
 * One sandcastle sandbox for the whole run: every agent call and command runs in the same warm
 * container, over a private clone; sandcastle keeps a worktree of the run branch on the host.
 */
export class SandcastleSession implements AgentSession, SandboxGit {
  private constructor(
    private readonly sandbox: Sandbox,
    private readonly options: SandcastleSessionOptions,
    private readonly clone: PrivateClone,
    private readonly codexAuth?: CodexAuthCache,
  ) {}

  /**
   * The repository path is resolved first: git records a worktree's real path, so a repository
   * opened through a symlink would leave git unusable inside the container.
   */
  static async open(
    options: SandcastleSessionOptions,
    start: SandboxFactory = createSandbox,
  ): Promise<Result<SandcastleSession, SessionOpenFailure>> {
    const repoRoot = await Result.tryPromise({
      try: () => realpath(options.repoRoot),
      catch: (cause) =>
        new ConfigInvalid({
          message: `Cannot resolve the repository path ${options.repoRoot}: ${messageOf(cause)}`,
        }),
    });
    if (repoRoot.isErr()) return Result.err(repoRoot.error);
    const ignored = await ignoreSandcastleDirectory(repoRoot.value);
    if (ignored.isErr()) return Result.err(ignored.error);
    const codexAuth = await openCodexAuth(options);
    if (codexAuth.isErr()) return Result.err(codexAuth.error);
    const cache = codexAuth.value;
    const clone = privateCloneDocker({
      imageName: options.imageName,
      branch: runBranchFor(options.runId),
      baseBranch: options.baseBranch,
      env: options.credentials,
      loginDirectory: cache?.directory,
    });
    const sandbox = await Result.tryPromise({
      try: () =>
        start({
          branch: runBranchFor(options.runId),
          baseBranch: options.baseBranch,
          cwd: repoRoot.value,
          sandbox: clone.provider,
        }),
      catch: sandboxStartFailure,
    });
    if (sandbox.isErr()) {
      await releaseAfterFailedOpen(cache, options.logger);
      return Result.err(sandbox.error);
    }
    const ready = await runSetupSteps(
      sandbox.value,
      setupSteps(repoRoot.value, options.setupCommand),
      options,
    );
    if (ready.isErr()) {
      await releaseAfterFailedOpen(cache, options.logger);
      return Result.err(ready.error);
    }
    return Result.ok(new SandcastleSession(sandbox.value, options, clone, cache));
  }

  get worktreePath(): string {
    return this.sandbox.worktreePath;
  }

  async run({ role, prompt }: AgentRunInput): Promise<Result<void, AgentRunFailed>> {
    const reply = await this.reply(role, this.options.agents[role], prompt);
    return reply.map(() => undefined);
  }

  private reply(
    role: AgentRole,
    agent: AgentProvider,
    prompt: string,
  ): Promise<Result<string, AgentRunFailed>> {
    return Result.tryPromise({
      try: async () => {
        const result = await this.sandbox.run({
          agent,
          prompt,
          idleTimeoutSeconds: this.options.idleTimeoutSeconds,
          logging: {
            type: 'file',
            path: this.options.agentLogFile,
            onAgentStreamEvent: (event) => this.publishAgentEvent(role, event),
          },
        });
        return result.stdout;
      },
      catch: (error) =>
        new AgentRunFailed({ message: `The ${role} agent failed: ${messageOf(error)}` }),
    });
  }

  private publishAgentEvent(role: AgentRole, event: AgentStreamEvent): void {
    const { runId, events } = this.options;
    if (event.type === 'text')
      events.publish({ type: 'agentMessage', runId, role, text: event.message });
    if (event.type === 'raw') {
      const usage = usageFromStreamLine(event.line);
      if (usage) events.publish({ type: 'agentUsage', runId, role, ...usage });
    }
    if (event.type === 'toolCall') {
      events.publish({
        type: 'agentToolCall',
        runId,
        role,
        tool: event.name,
        args: event.formattedArgs,
      });
    }
  }

  async runForOutput<T>({
    role,
    prompt,
    schema,
  }: AgentRunInput & { schema: ZodType<T> }): Promise<
    Result<T, AgentRunFailed | AgentOutputInvalid>
  > {
    const reply = await this.reply(
      role,
      this.options.agents[role],
      `${prompt}\n\n${outputInstruction()}`,
    );
    if (reply.isErr()) return Result.err(reply.error);
    return this.parseWithCorrections(role, reply.value, schema);
  }

  private async parseWithCorrections<T>(
    role: AgentRole,
    firstReply: string,
    schema: ZodType<T>,
  ): Promise<Result<T, AgentRunFailed | AgentOutputInvalid>> {
    let reply = firstReply;
    for (let correction = 0; ; correction++) {
      const parsed = extractOutput(reply, schema);
      if (parsed.isOk() || correction >= OUTPUT_CORRECTIONS) return parsed;
      const corrected = await this.reply(
        role,
        continuing(this.options.agents[role]),
        correctionPrompt(parsed.error.message),
      );
      if (corrected.isErr()) return Result.err(corrected.error);
      reply = corrected.value;
    }
  }

  async exec(command: string): Promise<Result<ExecResult, SandboxUnavailable>> {
    const result = await execInSandbox(this.sandbox, command);
    return result.map(({ exitCode, stdout, stderr }) => ({
      exitCode,
      output: `${stdout}${stderr}`.trim(),
    }));
  }

  async execGit(args: string[]): Promise<Result<ExecResult, SandboxUnavailable>> {
    const result = await execInSandbox(this.sandbox, ['git', ...args].map(shellQuote).join(' '));
    return result.map(({ exitCode, stdout, stderr }) => ({
      exitCode,
      output: exitCode === 0 ? stdout : `${stdout}${stderr}`.trim(),
    }));
  }

  copyOut(sandboxPath: string, hostPath: string): Promise<Result<void, GitCommandFailed>> {
    return this.clone.copyOut(sandboxPath, hostPath);
  }

  async close(): Promise<Result<void, SessionCloseFailure>> {
    const stopped = await stopSandbox(this.sandbox);
    const released = (await this.codexAuth?.close()) ?? Result.ok();
    if (stopped.isOk()) return released;
    if (released.isErr()) {
      this.options.logger.warn(
        { err: released.error },
        'cleanup failed after the sandbox did not stop',
      );
    }
    return stopped;
  }
}

/** Also replaces a catch-all `*`, which would hide the Dockerfile from the repository. */
export async function ignoreSandcastleDirectory(
  repoRoot: string,
): Promise<Result<void, ConfigInvalid>> {
  const directory = path.join(repoRoot, '.sandcastle');
  const gitignore = path.join(directory, '.gitignore');
  const refused = refuseSymlinks([directory, gitignore]);
  if (refused.isErr()) return refused;
  return Result.tryPromise({
    try: async () => {
      if (existsSync(gitignore) && !ignoresEverything(await readFile(gitignore, 'utf-8'))) return;
      await mkdir(directory, { recursive: true });
      await writeFile(gitignore, SANDCASTLE_GITIGNORE);
    },
    catch: (cause) =>
      new ConfigInvalid({ message: `Could not write ${gitignore}: ${messageOf(cause)}` }),
  });
}

function ignoresEverything(gitignore: string): boolean {
  return gitignore.split('\n').some((line) => line.trim() === '*');
}

/**
 * What sandcastle writes under `.sandcastle/` is scratch; the Dockerfile there is the
 * repository's own and gets committed. Untracked scratch would block the final merge.
 */
export const SANDCASTLE_GITIGNORE = 'worktrees/\nlogs/\n.env\n';

async function openCodexAuth(
  options: SandcastleSessionOptions,
): Promise<Result<CodexAuthCache | undefined, ConfigInvalid>> {
  return options.codexAuthDirectory
    ? openCodexAuthCache(options.codexAuthDirectory)
    : Result.ok(undefined);
}

/**
 * Sandcastle's own `onSandboxReady` hooks ignore a command's exit code and timeout in
 * `createSandbox`, so the setup command is run here, where both are checked.
 */
function sandboxStartFailure(error: unknown): ConfigInvalid | SandboxUnavailable {
  const message = `Could not start the sandbox: ${messageOf(error)}`;
  const tag = sandcastleFailureTag(error);
  return tag && CONFIGURATION_FAILURES.has(tag)
    ? new ConfigInvalid({ message: message })
    : new SandboxUnavailable({ message: message });
}

function sandcastleFailureTag(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = sandcastleFailureSchema.safeParse(Reflect.get(error, FIBER_FAILURE_CAUSE));
  return cause.success ? cause.data.error._tag : undefined;
}

const sandcastleFailureSchema = z.object({
  _tag: z.literal('Fail'),
  error: z.object({ _tag: z.string() }),
});

/**
 * Sandcastle runs on Effect, whose `runPromise` rejects with a FiberFailure carrying the cause
 * under this symbol; a plain failure's cause names sandcastle's tagged error.
 */
const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');

/**
 * The sandcastle failures a retry cannot fix. Sandcastle reports a Docker daemon that is down, an
 * image it cannot use and a git worktree it could not create all as `WorktreeError`, so only a
 * repository path it cannot use is told apart; the rest is retried a bounded number of times.
 */
const CONFIGURATION_FAILURES = new Set(['CwdError']);

/** The open already failed, so a failure to release the login is logged and the open's failure kept. */
async function releaseAfterFailedOpen(
  cache: CodexAuthCache | undefined,
  logger: Logger,
): Promise<void> {
  const released = await cache?.close();
  if (released?.isErr())
    logger.warn({ err: released.error }, 'cleanup failed after the open failed');
}

async function runSetupSteps(
  sandbox: Sandbox,
  steps: SetupStep[],
  options: SandcastleSessionOptions,
): Promise<Result<void, SandboxUnavailable | SetupCommandFailed>> {
  for (const step of steps) {
    const ran = await runSetupStep(sandbox, step, options);
    if (ran.isErr()) return ran;
  }
  return Result.ok();
}

async function runSetupStep(
  sandbox: Sandbox,
  step: SetupStep,
  { setupTimeoutSeconds, logger }: SandcastleSessionOptions,
): Promise<Result<void, SandboxUnavailable | SetupCommandFailed>> {
  const attempt = await Result.tryPromise({
    try: () => setupFailure(sandbox, step, setupTimeoutSeconds),
    catch: (error) =>
      new SandboxUnavailable({ message: `Could not run ${step.name}: ${messageOf(error)}` }),
  });
  const failure = attempt.isErr() ? attempt.error : attempt.value;
  if (!failure) return Result.ok();
  const stopped = await stopSandbox(sandbox);
  if (stopped.isErr()) logger.warn({ err: stopped.error }, 'cleanup failed after the setup failed');
  return Result.err(failure);
}

async function setupFailure(
  sandbox: Sandbox,
  { name, command }: SetupStep,
  timeoutSeconds: number,
): Promise<SetupCommandFailed | undefined> {
  const timer = new AbortController();
  const finished = await Promise.race([
    sandbox.exec(command),
    delay(timeoutSeconds * 1000, undefined, { signal: timer.signal }),
  ]).finally(() => timer.abort());
  if (!finished) {
    return new SetupCommandFailed({
      message: `${name} did not finish within ${timeoutSeconds}s`,
      output: '',
    });
  }
  if (finished.exitCode === 0) return undefined;
  const output = `${finished.stdout}${finished.stderr}`.trim().slice(-SETUP_OUTPUT_TAIL);
  return new SetupCommandFailed({
    message: `${name} exited with ${finished.exitCode}:\n${output}`,
    output,
  });
}

/** How much of a failed setup command's output is kept; the end is where the error is. */
const SETUP_OUTPUT_TAIL = 3000;

function stopSandbox(sandbox: Sandbox): Promise<Result<void, SandboxUnavailable>> {
  return Result.tryPromise({
    try: async () => {
      await sandbox.close();
    },
    catch: (cause) =>
      new SandboxUnavailable({ message: `Could not stop the sandbox: ${messageOf(cause)}` }),
  });
}

/**
 * The setup command, then the repository's git hooks, so commits made in the sandbox meet the
 * same checks as the operator's. Without a setup command nothing installed the hook manager.
 */
function setupSteps(repoRoot: string, setupCommand: string | undefined): SetupStep[] {
  if (!setupCommand) return [];
  const steps = [{ name: `setupCommand "${setupCommand}"`, command: setupCommand }];
  const hooks = hookManagerOf(repoRoot);
  if (!hooks) return steps;
  return [
    ...steps,
    {
      name: `installing ${hooks.name}'s git hooks ("${hooks.installCommand}")`,
      command: hooks.installCommand,
    },
  ];
}

/** How many times an agent is asked, in its own session, to correct output that did not parse. */
const OUTPUT_CORRECTIONS = 1;

/** The same agent, resuming its last conversation in this sandbox instead of starting a new one. */
function continuing(agent: AgentProvider): AgentProvider {
  return {
    ...agent,
    buildPrintCommand: (options) => {
      const built = agent.buildPrintCommand(options);
      if (agent.name === 'codex') {
        return {
          ...built,
          command: `${built.command.replace(/^codex exec\b/, 'codex exec resume --last')} -`,
        };
      }
      return { ...built, command: `${built.command} --continue` };
    },
  };
}

function correctionPrompt(problem: string): string {
  return [
    `Your result could not be used: ${problem}`,
    `Reply again with only the corrected result inside <${OUTPUT_TAG}></${OUTPUT_TAG}> tags.`,
  ].join('\n');
}

/** A container that died under a command is Docker's trouble, not the command's answer. */
function execInSandbox(
  sandbox: Sandbox,
  command: string,
): Promise<Result<SandboxExecResult, SandboxUnavailable>> {
  return Result.tryPromise({
    try: () => sandbox.exec(command),
    catch: (cause) =>
      new SandboxUnavailable({
        message: `Could not run a command in the sandbox: ${messageOf(cause)}`,
      }),
  });
}
