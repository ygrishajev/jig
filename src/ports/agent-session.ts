import { type Result, TaggedError } from 'better-result';
import type { ZodType } from 'zod';

import type { AgentRole } from '../domain/agent-role.js';

/**
 * One run's sandbox: agents work in the run's worktree and commands execute there.
 * Which agent and model serve a role is the adapter's concern.
 */
export interface AgentSession {
  run(input: AgentRunInput): Promise<Result<void, AgentRunFailed>>;
  runForOutput<T>(
    input: AgentRunInput & { schema: ZodType<T> },
  ): Promise<Result<T, AgentRunFailed | AgentOutputInvalid>>;
  /** A command's exit code is its answer; an `Err` means the sandbox could not run it at all. */
  exec(command: string): Promise<Result<ExecResult, SandboxUnavailable>>;
}

export interface AgentRunInput {
  role: AgentRole;
  prompt: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

/** Every failure an agent session's methods return. */
export type AgentSessionFailure = AgentRunFailed | AgentOutputInvalid | SandboxUnavailable;

export class AgentRunFailed extends TaggedError('AgentRunFailed')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/** The agent's own reply was malformed; a fresh attempt at the same step may well get it right. */
export class AgentOutputInvalid extends TaggedError('AgentOutputInvalid')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * The sandbox did not start: the Docker daemon, a container start, or creating the worktree
 * failed in a way sandcastle does not tell apart from a passing hiccup, so it is worth another go.
 */
export class SandboxUnavailable extends TaggedError('SandboxUnavailable')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * The setup command exited non-zero or outlived its timeout. It is the project's toolchain, so
 * `init` hands it back to the planner; in a run it is retried, since `npm ci` fails on a network
 * blip as readily as on a broken lockfile.
 */
export class SetupCommandFailed extends TaggedError('SetupCommandFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'retry' as const;
}

/** The agent credentials a sandbox needs are missing or unusable, the Codex login included. */
export class SandboxCredentialsInvalid extends TaggedError('SandboxCredentialsInvalid')<{
  message: string;
}> {
  readonly kind = 'fatal' as const;
}

/**
 * The sandbox cannot be prepared for a reason the operator fixes: the repository path, the
 * sandbox's scratch files, its Dockerfile recipe, or a sandbox option sandcastle refuses.
 */
export class SandboxPreparationInvalid extends TaggedError('SandboxPreparationInvalid')<{
  message: string;
}> {
  readonly kind = 'fatal' as const;
}

/**
 * The Codex login a run refreshed could not be handed back to the operator's own login, or its
 * lock could not be let go; the run's work is unaffected.
 */
export class CodexLoginNotSaved extends TaggedError('CodexLoginNotSaved')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

export type { AgentRole };
