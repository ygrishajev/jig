import { z } from 'zod';

import { isJigError } from '../domain/errors.js';
import type { RunStateIn } from '../domain/run-state.js';
import type { RunStep, StepPorts } from '../flow/define-flow.js';
import { pullRequestPrompt } from '../prompts/pull-request.js';
import { DEFAULT_PR_TEMPLATE, renderPullRequest } from './pull-request-description.js';

/** Best effort: if the describer fails, the run still gets a description built from its own state. */
export const describePullRequest: RunStep<'describing'> = async ({ state, ports, settings }) => {
  const template = await findTemplate(ports);
  const filled = await fillTemplate(
    state,
    ports,
    template ?? DEFAULT_PR_TEMPLATE,
    settings.verifyCommand,
  );
  return { type: 'described', body: renderPullRequest(state, { filled, template }) };
};

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
  try {
    const { body } = await ports.agent.runForOutput({
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
    return body.trim();
  } catch (error) {
    if (isJigError(error) && error.kind !== 'fatal') return undefined;
    throw error;
  }
}

const descriptionSchema = z.object({ body: z.string().min(1) });

export const mergeRunBranch: RunStep = async ({ ports, settings }) => {
  if (await ports.workspace.isRunBranchMerged()) return { type: 'merged' };
  if (settings.mergeMode === 'manual') return { type: 'awaitingManualMerge' };
  await ports.workspace.mergeRunBranch();
  return { type: 'merged' };
};
