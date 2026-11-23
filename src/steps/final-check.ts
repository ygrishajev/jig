import { Result } from 'better-result';

import { fulfillmentVerdictSchema } from '../domain/final-check.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunStep } from '../flow/define-flow.js';
import {
  type AgentOutputInvalid,
  type AgentRunFailed,
  type ExecResult,
} from '../ports/agent-session.js';
import type { GitCommandFailed } from '../ports/git-failures.js';
import type { SandboxUnavailable } from '../ports/sandbox.js';
import { finalCheckPrompt, type FinalCheckVerification } from '../prompts/final-check.js';

/**
 * The whole-run final check: runs the configured verification once in the sandbox, then has the
 * reviewer judge the entire run against its request even when verification failed. It commits
 * nothing and imports nothing — any repair goes back through the slices.
 */
export const checkWholeRun: RunStep<
  'finalCheck',
  AgentRunFailed | AgentOutputInvalid | GitCommandFailed | SandboxUnavailable
> = ({ state, ports, settings }) =>
  Result.gen(async function* () {
    const command = settings.verifyCommand;
    const ran = command ? yield* Result.await(ports.agent.exec(command)) : undefined;
    const verification = ran && command ? verificationOf(command, ran) : undefined;
    const start = yield* Result.await(ports.workspace.forkPoint());
    const verdict = yield* Result.await(
      ports.agent.runForOutput({
        role: 'reviewer',
        prompt: finalCheckPrompt({
          request: state.request,
          plan: state.docs.plan,
          range: `${start}..HEAD`,
          verification,
        }),
        schema: fulfillmentVerdictSchema,
      }),
    );
    return Result.ok<Outcome>({
      type: 'finalChecked',
      verified: verification?.passed ?? true,
      command: verification?.command,
      output: verification?.output,
      fulfilled: verdict.fulfilled,
      gaps: verdict.gaps,
    });
  });

function verificationOf(command: string, ran: ExecResult): FinalCheckVerification {
  return {
    command,
    passed: ran.exitCode === 0,
    ...(ran.exitCode === 0 ? {} : { output: ran.output }),
  };
}
