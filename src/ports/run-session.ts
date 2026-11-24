import type { Result } from 'better-result';

import type { AgentSession, CodexLoginNotSaved, SandboxUnavailable } from './agent-session.js';
import type { SandboxGit } from './sandbox-git.js';

/** The run's sandbox: where agents and commands run, and the host worktree of the run branch. */
export interface RunSession extends AgentSession, SandboxGit {
  readonly worktreePath: string;
  close(): Promise<Result<void, SessionCloseFailure>>;
}

/** Why a sandbox did not close cleanly: the container would not stop, or the login was not handed back. */
export type SessionCloseFailure = SandboxUnavailable | CodexLoginNotSaved;
