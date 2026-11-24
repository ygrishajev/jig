import type { Result } from 'better-result';

import type { MissingCredential } from '../../config/agent-policy.js';
import type { JigEnvironment } from '../../config/environment.js';
import type { ConfigInvalid } from '../../config/errors.js';
import type { StepConfig } from '../../config/load-config.js';
import type { SandboxCredentialsInvalid } from '../../ports/agent-session.js';
import type { LocalPreparationFailed, LocalStateUnwritable } from '../../ports/local-state.js';
import { saveCredential } from '../local-store/credentials-file.js';
import { collectCredentials, missingCredentials } from './agents.js';

/** The credentials each agent reads, and the repository's owner-only, git-ignored file for them. */
export class RepositoryAgentCredentials {
  constructor(private readonly repoRoot: string) {}

  missing(
    steps: StepConfig[],
    environment: JigEnvironment,
  ): Result<MissingCredential[], ConfigInvalid> {
    return missingCredentials(steps, environment.credential);
  }

  check(
    steps: StepConfig[],
    environment: JigEnvironment,
  ): Result<void, ConfigInvalid | SandboxCredentialsInvalid> {
    return collectCredentials(steps, environment.credential).map(() => undefined);
  }

  save({
    name,
    value,
  }: {
    name: string;
    value: string;
  }): Promise<Result<void, LocalPreparationFailed | LocalStateUnwritable>> {
    return saveCredential(this.repoRoot, name, value);
  }
}
