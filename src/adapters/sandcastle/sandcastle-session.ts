import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createSandbox,
  type AgentProvider,
  type AgentStreamEvent,
  type CreateSandboxOptions,
  type Sandbox,
} from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { z, type ZodType } from 'zod';
import {
  AgentOutputInvalid,
  AgentRunFailed,
  ConfigInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
  type SdlcError,
} from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import type {
  AgentRole,
  AgentRunInput,
  AgentSession,
  ExecResult,
} from '../../ports/agent-session.js';
import type { EventSink } from '../../ports/observability.js';
import { extractOutput, OUTPUT_TAG, outputInstruction } from './structured-output.js';
import { usageFromStreamLine } from './usage.js';

/** How many times an agent is asked, in its own session, to correct output that did not parse. */
const OUTPUT_CORRECTIONS = 1;

/** How much of a failed setup command's output is kept; the end is where the error is. */
const SETUP_OUTPUT_TAIL = 3000;

/**
 * Sandcastle runs on Effect, whose `runPromise` rejects with a FiberFailure carrying the cause
 * under this symbol; a plain failure's cause names sandcastle's tagged error.
 */
const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');

const sandcastleFailureSchema = z.object({
  _tag: z.literal('Fail'),
  error: z.object({ _tag: z.string() }),
});

/**
 * The sandcastle failures a retry cannot fix. Sandcastle reports a Docker daemon that is down, an
 * image it cannot use and a git worktree it could not create all as `WorktreeError`, so only a
 * repository path it cannot use is told apart; the rest is retried a bounded number of times.
 */
const CONFIGURATION_FAILURES = new Set(['CwdError']);

export type SandboxFactory = (options: CreateSandboxOptions) => Promise<Sandbox>;

export interface SandcastleSessionOptions {
  repoRoot: string;
  runId: RunId;
  baseBranch: string;
  imageName: string;
  credentials: Record<string, string>;
  agents: Record<AgentRole, AgentProvider>;
  skipCommitSigning: boolean;
  /** Runs once inside the sandbox before any agent, e.g. `npm ci`. */
  setupCommand?: string;
  setupTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  agentLogFile: string;
  events: EventSink;
}

/**
 * One sandcastle sandbox for the whole run: every agent call and command runs in the same warm
 * container, over the worktree sandcastle keeps for the run branch.
 */
export class SandcastleSession implements AgentSession {
  private constructor(
    private readonly sandbox: Sandbox,
    private readonly options: SandcastleSessionOptions,
  ) {}

  /**
   * The repository path is resolved first: git records a worktree's real path, so a repository
   * opened through a symlink would leave git unusable inside the container.
   */
  static async open(options: SandcastleSessionOptions, start: SandboxFactory = createSandbox) {
    const repoRoot = await realpath(options.repoRoot);
    await ignoreSandcastleDirectory(repoRoot);
    const sandbox = await start({
      branch: runBranchFor(options.runId),
      baseBranch: options.baseBranch,
      cwd: repoRoot,
      sandbox: docker({ imageName: options.imageName, env: options.credentials }),
      hooks: sandboxHooks(options),
    }).catch((error: unknown) => {
      throw sandboxStartFailure(error);
    });
    if (options.setupCommand) await runSetupCommand(sandbox, options.setupCommand, options);
    return new SandcastleSession(sandbox, options);
  }

  get worktreePath() {
    return this.sandbox.worktreePath;
  }

  async run({ role, prompt }: AgentRunInput) {
    await this.reply(role, this.options.agents[role], prompt);
  }

  async runForOutput<T>({ role, prompt, schema }: AgentRunInput & { schema: ZodType<T> }) {
    const reply = await this.reply(
      role,
      this.options.agents[role],
      `${prompt}\n\n${outputInstruction()}`,
    );
    return this.parseWithCorrections(role, reply, schema);
  }

  async exec(command: string): Promise<ExecResult> {
    const result = await this.sandbox.exec(command);
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() };
  }

  async close() {
    await this.sandbox.close();
  }

  private async parseWithCorrections<T>(role: AgentRole, firstReply: string, schema: ZodType<T>) {
    let reply = firstReply;
    for (let correction = 0; ; correction++) {
      try {
        return extractOutput(reply, schema);
      } catch (error) {
        if (!(error instanceof AgentOutputInvalid) || correction >= OUTPUT_CORRECTIONS) throw error;
        reply = await this.reply(
          role,
          continuing(this.options.agents[role]),
          correctionPrompt(error.message),
        );
      }
    }
  }

  private async reply(role: AgentRole, agent: AgentProvider, prompt: string) {
    try {
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
    } catch (error) {
      throw new AgentRunFailed(`The ${role} agent failed: ${messageOf(error)}`);
    }
  }

  private publishAgentEvent(role: AgentRole, event: AgentStreamEvent) {
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
}

/** The same agent, resuming its last conversation in this sandbox instead of starting a new one. */
function continuing(agent: AgentProvider): AgentProvider {
  return {
    ...agent,
    buildPrintCommand: (options) => {
      const built = agent.buildPrintCommand(options);
      return { ...built, command: `${built.command} --continue` };
    },
  };
}

function correctionPrompt(problem: string) {
  return [
    `Your result could not be used: ${problem}`,
    `Reply again with only the corrected result inside <${OUTPUT_TAG}></${OUTPUT_TAG}> tags.`,
  ].join('\n');
}

/**
 * Sandcastle's own `onSandboxReady` hooks ignore a command's exit code and timeout in
 * `createSandbox`, so the setup command is run here, where both are checked.
 */
function sandboxHooks(options: SandcastleSessionOptions) {
  return { host: options.skipCommitSigning ? { onWorktreeReady: [disableSigning()] } : undefined };
}

async function runSetupCommand(
  sandbox: Sandbox,
  command: string,
  { setupTimeoutSeconds }: SandcastleSessionOptions,
) {
  const failure = await setupFailure(sandbox, command, setupTimeoutSeconds).catch(
    (error: unknown) =>
      new SandboxUnavailable(`Could not run the setup command: ${messageOf(error)}`),
  );
  if (!failure) return;
  await sandbox.close();
  throw failure;
}

async function setupFailure(sandbox: Sandbox, command: string, timeoutSeconds: number) {
  const timer = new AbortController();
  const finished = await Promise.race([
    sandbox.exec(command),
    delay(timeoutSeconds * 1000, undefined, { signal: timer.signal }),
  ]).finally(() => timer.abort());
  if (!finished) {
    return new SetupCommandFailed(
      `setupCommand "${command}" did not finish within ${timeoutSeconds}s`,
      '',
    );
  }
  if (finished.exitCode === 0) return undefined;
  const output = `${finished.stdout}${finished.stderr}`.trim().slice(-SETUP_OUTPUT_TAIL);
  return new SetupCommandFailed(
    `setupCommand "${command}" exited with ${finished.exitCode}:\n${output}`,
    output,
  );
}

function sandboxStartFailure(error: unknown): SdlcError {
  const message = `Could not start the sandbox: ${messageOf(error)}`;
  const tag = sandcastleFailureTag(error);
  return tag && CONFIGURATION_FAILURES.has(tag)
    ? new ConfigInvalid(message)
    : new SandboxUnavailable(message);
}

function sandcastleFailureTag(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  const cause = sandcastleFailureSchema.safeParse(Reflect.get(error, FIBER_FAILURE_CAUSE));
  return cause.success ? cause.data.error._tag : undefined;
}

function disableSigning() {
  return {
    command:
      'git config extensions.worktreeConfig true && git config --worktree commit.gpgsign false',
  };
}

/**
 * What sandcastle writes under `.sandcastle/` is scratch; the Dockerfile there is the
 * repository's own and gets committed. Untracked scratch would block the final merge.
 */
export const SANDCASTLE_GITIGNORE = 'worktrees/\nlogs/\n.env\n';

/** Also replaces a catch-all `*`, which would hide the Dockerfile from the repository. */
export async function ignoreSandcastleDirectory(repoRoot: string) {
  const directory = path.join(repoRoot, '.sandcastle');
  const gitignore = path.join(directory, '.gitignore');
  if (existsSync(gitignore) && !ignoresEverything(await readFile(gitignore, 'utf-8'))) return;
  await mkdir(directory, { recursive: true });
  await writeFile(gitignore, SANDCASTLE_GITIGNORE);
}

function ignoresEverything(gitignore: string) {
  return gitignore.split('\n').some((line) => line.trim() === '*');
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
