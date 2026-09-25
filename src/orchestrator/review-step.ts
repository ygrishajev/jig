import { execa } from 'execa';
import { z } from 'zod';
import type { SdlcConfig } from '../config/load-config.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { Slice } from '../state/types.js';
import {
  readStructuredOutput,
  resetStructuredOutput,
  structuredOutputInstruction,
} from './structured-output.js';

const reviewOutputSchema = z.object({ approved: z.boolean(), feedback: z.string() });

export interface ReviewStepInput {
  paths: RunPaths;
  slice: Slice;
  provider: AgentProvider;
  config: SdlcConfig;
}

export async function runReviewStep(input: ReviewStepInput): Promise<void> {
  const { paths, slice, provider, config } = input;

  await resetStructuredOutput(paths.workspaceDir);
  const reviewResult = await provider.run({
    cwd: paths.workspaceDir,
    prompt: buildReviewPrompt(slice),
  });
  if (!reviewResult.success) {
    requestChanges(
      slice,
      config.reviewCycleCap,
      `Review step failed to run: ${reviewResult.output}`,
    );
    return;
  }
  const review = await readStructuredOutput(paths.workspaceDir, (raw) =>
    reviewOutputSchema.parse(raw),
  );
  if (!review.approved) {
    requestChanges(slice, config.reviewCycleCap, review.feedback);
    return;
  }

  if (config.verifyCommand) {
    const verifyResult = await runVerifyCommand(paths.workspaceDir, config.verifyCommand);
    if (!verifyResult.ok) {
      requestChanges(
        slice,
        config.reviewCycleCap,
        `The reviewer approved this slice, but the verify command ("${config.verifyCommand}") failed:\n${verifyResult.detail}`,
      );
      return;
    }
  }

  slice.lastFeedback = undefined;
  slice.status = 'ready_to_merge';
}

function requestChanges(slice: Slice, reviewCycleCap: number, feedback: string): void {
  slice.reviewCycles += 1;
  slice.lastFeedback = feedback;
  slice.status = slice.reviewCycles >= reviewCycleCap ? 'stuck' : 'pending';
}

const VERIFY_DETAIL_MAX_LENGTH = 400;

type VerifyResult = { ok: true } | { ok: false; detail: string };

async function runVerifyCommand(cwd: string, verifyCommand: string): Promise<VerifyResult> {
  try {
    await execa(verifyCommand, { cwd, shell: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: truncate(extractErrorDetail(error), VERIFY_DETAIL_MAX_LENGTH) };
  }
}

function extractErrorDetail(error: unknown): string {
  if (error && typeof error === 'object') {
    const execaError = error as { stderr?: unknown; stdout?: unknown; shortMessage?: unknown };
    const stderr = typeof execaError.stderr === 'string' ? execaError.stderr.trim() : '';
    if (stderr) return stderr;
    const stdout = typeof execaError.stdout === 'string' ? execaError.stdout.trim() : '';
    if (stdout) return stdout;
    const shortMessage =
      typeof execaError.shortMessage === 'string' ? execaError.shortMessage.trim() : '';
    if (shortMessage) return shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function buildReviewPrompt(slice: Slice): string {
  return [
    'You are the review step of an automated SDLC pipeline.',
    `Review the uncommitted and committed changes in this worktree for the slice below.`,
    '',
    `Slice: ${slice.title}`,
    `Description: ${slice.description}`,
    '',
    'Decide whether this slice is ready to merge as-is.',
    'Respond with JSON matching: { "approved": boolean, "feedback": string }.',
    'If approved is false, feedback must explain exactly what needs to change.',
    structuredOutputInstruction(),
  ].join('\n');
}
