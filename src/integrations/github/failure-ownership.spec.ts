import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { RunRequestInvalid } from '../../app/errors.js';
import { RunStoreSetupInvalid } from '../../app/run-stores.js';
import { CommandInputInvalid } from '../../cli/with-input.js';
import { ConfigInvalid } from '../../config/errors.js';
import { DesignUnresolved, PlanNotCovered } from '../../domain/errors.js';
import {
  AgentOutputInvalid,
  AgentRunFailed,
  CodexLoginNotSaved,
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../../ports/agent-session.js';
import {
  GitCommandFailed,
  RemoteUnavailable,
  RepositoryInvalid,
} from '../../ports/git-failures.js';
import { LocalPreparationFailed, LocalStateUnwritable } from '../../ports/local-state.js';
import {
  MetricsLogCorrupt,
  RunCodeUnavailable,
  RunInProgress,
  RunStateConflict,
  RunStateInvalid,
} from '../../ports/run-state-failures.js';
import { RunStoreOperationFailed } from '../../ports/run-store.js';
import { ImageBuildFailed } from '../../ports/sandbox-images.js';
import { CommitImportRefused, CommitRejected, MergeFailed } from '../../ports/workspace.js';
import {
  BaseBranchMismatch,
  GithubNotFound,
  GithubRefused,
  GithubSetupInvalid,
  GithubUnavailable,
  OrchestrationStateInvalid,
  PublicationInProgress,
  RunBranchUnpublishable,
} from './errors.js';

const failureClasses = [
  PlanNotCovered,
  DesignUnresolved,
  AgentRunFailed,
  AgentOutputInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  CodexLoginNotSaved,
  RemoteUnavailable,
  GitCommandFailed,
  RepositoryInvalid,
  RunStateConflict,
  RunCodeUnavailable,
  RunStateInvalid,
  RunInProgress,
  MetricsLogCorrupt,
  LocalStateUnwritable,
  LocalPreparationFailed,
  RunStoreOperationFailed,
  ImageBuildFailed,
  MergeFailed,
  CommitImportRefused,
  CommitRejected,
  ConfigInvalid,
  RunRequestInvalid,
  RunStoreSetupInvalid,
  CommandInputInvalid,
  GithubUnavailable,
  GithubRefused,
  GithubNotFound,
  GithubSetupInvalid,
  BaseBranchMismatch,
  OrchestrationStateInvalid,
  PublicationInProgress,
  RunBranchUnpublishable,
];

describe('failure classes across owners', () => {
  it('gives every class a tag equal to its own name', () => {
    const tags = failureClasses.map((Failure) => {
      const failure = new Failure({
        message: faker.lorem.sentence(),
        findingIds: [],
        command: '',
        output: '',
        path: '',
      });
      return [failure._tag, Failure.name];
    });

    expect(tags.filter(([tag, name]) => tag !== name)).toEqual([]);
  });

  it('never gives two classes the same name', () => {
    const names = failureClasses.map((Failure) => Failure.name);

    expect(new Set(names).size).toBe(names.length);
  });
});
