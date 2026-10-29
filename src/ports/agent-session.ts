import type { ZodType } from 'zod';
import type { AgentRole } from '../domain/agent-role.js';

export type { AgentRole };

export interface AgentRunInput {
  role: AgentRole;
  prompt: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

/**
 * One run's sandbox: agents work in the run's worktree and commands execute there.
 * Which agent and model serve a role is the adapter's concern.
 */
export interface AgentSession {
  /** Throws `AgentRunFailed` when the agent exits unsuccessfully. */
  run(input: AgentRunInput): Promise<void>;
  /** Throws `AgentRunFailed`, or `AgentOutputInvalid` when the result does not match `schema`. */
  runForOutput<T>(input: AgentRunInput & { schema: ZodType<T> }): Promise<T>;
  exec(command: string): Promise<ExecResult>;
}
