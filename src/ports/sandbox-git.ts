import type { Result } from 'better-result';

import type { GitCommandFailed } from '../domain/errors.js';
import type { ExecResult } from './agent-session.js';

/** Git in the run's sandbox, and the one way bytes leave it. Everything it answers is untrusted. */
export interface SandboxGit {
  /** Runs git in the sandbox's clone. `output` is stdout, with stderr added on a failure. */
  execGit(args: string[]): Promise<ExecResult>;
  /** Copies a file's bytes, relative to the clone, into a new file on the host. */
  copyOut(sandboxPath: string, hostPath: string): Promise<Result<void, GitCommandFailed>>;
}
