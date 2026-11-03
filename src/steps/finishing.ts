import { Result } from 'better-result';
import { z } from 'zod';

import type { JigError } from '../domain/errors.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunStateIn } from '../domain/run-state.js';
import type { RunStep, StepPorts } from '../flow/define-flow.js';
import { pullRequestPrompt } from '../prompts/pull-request.js';
import { DEFAULT_PR_TEMPLATE, renderPullRequest } from './pull-request-description.js';

/** Best effort: if the describer fails, the run still gets a description built from its own state. */
export const describePullRequest: RunStep<'describing'> = ({ state, ports, settings }) =>
  Result.gen(async function* () {
    const template = await findTemplate(ports);
    const filled = yield* Result.await(
      fillTemplate(state, ports, template ?? DEFAULT_PR_TEMPLATE, settings.verifyCommand),
    );
    return Result.ok<Outcome>({
      type: 'described',
      body: renderPullRequest(state, { filled, template }),
    });
  });

async function findTemplate(ports: StepPorts): Promise<string | undefined> {
  for (const relativePath of TEMPLATE_PATHS) {
    const template = await ports.workspace.readRepoFile(relativePath);
    if (template !== undefined) return template.trim();
  }
  return undefined;
}

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
];

async function fillTemplate(
  state: RunStateIn<'describing'>,
  ports: StepPorts,
  template: string,
  verifyCommand?: string,
): Promise<Result<string | undefined, JigError>> {
  const described = await ports.agent.runForOutput({
    role: 'describer',
    prompt: pullRequestPrompt({
      template,
      plan: state.plan,
      slices: state.slices,
      design: state.docs.design,
      verifyCommand,
    }),
    schema: descriptionSchema,
  });
  return described.isOk() ? Result.ok(described.value.body.trim()) : passOnFatal(described.error);
}

const descriptionSchema = z.object({ body: z.string().min(1) });

/** The describer is best effort: only a failure that must end the invocation is passed on. */
function passOnFatal(error: JigError): Result<undefined, JigError> {
  return error.kind === 'fatal' ? Result.err(error) : Result.ok(undefined);
}

export const mergeRunBranch: RunStep = ({ ports, settings }) =>
  Result.gen(async function* () {
    if (yield* Result.await(ports.workspace.isRunBranchMerged())) {
      return Result.ok<Outcome>({ type: 'merged' });
    }
    if (settings.mergeMode === 'manual') return Result.ok<Outcome>({ type: 'awaitingManualMerge' });
    yield* Result.await(ports.workspace.mergeRunBranch());
    return Result.ok<Outcome>({ type: 'merged' });
  });
