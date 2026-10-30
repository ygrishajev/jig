import { z } from 'zod';

import { SdlcError } from '../domain/errors.js';
import type { RunStateIn } from '../domain/run-state.js';
import type { RunStep, StepPorts } from '../flow/define-flow.js';
import { pullRequestPrompt } from '../prompts/pull-request.js';
import { DEFAULT_PR_TEMPLATE, renderPullRequest } from './pull-request-description.js';

const descriptionSchema = z.object({ body: z.string().min(1) });

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
];

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

export const mergeRunBranch: RunStep = async ({ ports, settings }) => {
  if (await ports.workspace.isRunBranchMerged()) return { type: 'merged' };
  if (settings.mergeMode === 'manual') return { type: 'awaitingManualMerge' };
  await ports.workspace.mergeRunBranch();
  return { type: 'merged' };
};

async function findTemplate(ports: StepPorts) {
  for (const relativePath of TEMPLATE_PATHS) {
    const template = await ports.workspace.readRepoFile(relativePath);
    if (template !== undefined) return template.trim();
  }
  return undefined;
}

async function fillTemplate(
  state: RunStateIn<'describing'>,
  ports: StepPorts,
  template: string,
  verifyCommand?: string,
) {
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
    if (error instanceof SdlcError && error.kind !== 'fatal') return undefined;
    throw error;
  }
}
