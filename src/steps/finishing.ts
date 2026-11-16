import { Result } from 'better-result';
import { z } from 'zod';

import { reusedCompletion } from '../domain/completion-reuse.js';
import type { Outcome } from '../domain/outcome.js';
import type { RunStateIn } from '../domain/run-state.js';
import { slicesInOrder } from '../domain/slice.js';
import type { RunStep, StepPorts } from '../flow/define-flow.js';
import { pullRequestPrompt } from '../prompts/pull-request.js';
import { completionInvalidated } from './completion-reuse.js';
import { DEFAULT_PR_TEMPLATE, renderPullRequest } from './pull-request-description.js';

/**
 * Best effort: if the describer fails, the run still gets a description built from its own state.
 * A run finishing on reused evidence first checks that evidence still holds, and describes nothing
 * when it does not.
 */
export const describePullRequest: RunStep<'describing'> = (context) =>
  Result.gen(async function* () {
    if (yield* Result.await(completionInvalidated(context))) {
      return Result.ok<Outcome>({ type: 'completionInvalidated' });
    }
    const { state, ports, settings } = context;
    const template = await findTemplate(ports);
    const filled = await fillTemplate(
      state,
      ports,
      template ?? DEFAULT_PR_TEMPLATE,
      settings.verifyCommand,
    );
    return Result.ok<Outcome>({
      type: 'described',
      body: renderPullRequest(state, { filled, template, verifyCommand: settings.verifyCommand }),
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
): Promise<string | undefined> {
  const described = await ports.agent.runForOutput({
    role: 'describer',
    prompt: pullRequestPrompt({
      template,
      plan: state.plan,
      slices: state.slices,
      design: state.docs.design,
      verifyCommand,
      finalCheck: state.finalCheck,
      reusedCompletion: reusedCompletion(state),
    }),
    schema: descriptionSchema,
  });
  return described.isOk() ? described.value.body.trim() : undefined;
}

const descriptionSchema = z.object({ body: z.string().min(1) });

/**
 * A branch the operator already merged is done. Otherwise a run finishing on reused evidence
 * checks it still holds before it merges or waits for a person to, resumed waits included.
 */
export const mergeRunBranch: RunStep = (context) =>
  Result.gen(async function* () {
    const { state, ports, settings } = context;
    if (yield* Result.await(ports.workspace.isRunBranchMerged())) {
      return Result.ok<Outcome>({ type: 'merged' });
    }
    if (yield* Result.await(completionInvalidated(context))) {
      return Result.ok<Outcome>({ type: 'completionInvalidated' });
    }
    if (settings.mergeMode === 'manual') return Result.ok<Outcome>({ type: 'awaitingManualMerge' });
    const approved = slicesInOrder(state.slices).at(-1)?.commit;
    yield* Result.await(ports.workspace.mergeRunBranch({ approved }));
    return Result.ok<Outcome>({ type: 'merged' });
  });
