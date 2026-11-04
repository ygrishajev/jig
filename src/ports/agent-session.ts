import type { Result } from 'better-result';
import type { ZodType } from 'zod';

import type { AgentRole } from '../domain/agent-role.js';
import type { AgentOutputInvalid, AgentRunFailed, SandboxUnavailable } from '../domain/errors.js';

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

export type { AgentRole };
