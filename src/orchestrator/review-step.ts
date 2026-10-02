import { execa } from 'execa';
import { z } from 'zod';
import type { SdlcConfig } from '../config/load-config.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { Slice } from '../state/types.js';
import { buildReviewPrompt } from './prompts.js';
import { logRun } from '../logging.js';
import { readStructuredOutput, resetStructuredOutput } from './structured-output.js';

const reviewOutputSchema = z.object({ approved: z.boolean(), feedback: z.string() });

export interface ReviewStepInput {
  paths: RunPaths;
  slice: Slice;
  provider: AgentProvider;
  config: SdlcConfig;
}

export async function runReviewStep(input: ReviewStepInput): Promise<void> {
  const { paths, slice, provider, config } = input;
  logRun(paths.runId, `reviewing slice "${slice.id}": ${slice.title}`);

  await resetStructuredOutput(paths.workspaceDir);
  const reviewResult = await provider.run({
    cwd: paths.workspaceDir,
    repoRoot: paths.repoRoot,
    prompt: buildReviewPrompt(slice),
  });
  if (!reviewResult.success) {
    requestChanges(
      paths,
      slice,
      config.reviewCycleCap,
      `Review step failed to run: ${reviewResult.output}`,
    );
    return;
  }
  let review: { approved: boolean; feedback: string };
  try {
    review = await readStructuredOutput(paths.workspaceDir, (raw) => reviewOutputSchema.parse(raw));
  } catch (error) {
    // A provider that exits 0 but never writes the structured-output file
    // (ENOENT), writes malformed JSON (SyntaxError), or writes the wrong
    // shape (ZodError) is arguably the most likely real-world agentic-CLI
    // failure mode. Left uncaught, any of these would propagate straight out
    // of the whole reconciler pass and abort the entire autopilot run instead
    // of being treated like any other failed review attempt.
    await resetStructuredOutput(paths.workspaceDir);
    const message = error instanceof Error ? error.message : String(error);
    requestChanges(
      paths,
      slice,
      config.reviewCycleCap,
      `Review step did not produce valid structured output: ${message}`,
    );
    return;
  }
  // Mirrors prepare.ts: reset immediately after a successful read so the
  // structured-output file never lingers in the workspace worktree past this
  // point. Left behind, it sits untracked until the next commitAll's
  // `git add -A` sweeps it into the slice's commit — landing the agent's raw
  // review-verdict JSON in the user's merged history.
  await resetStructuredOutput(paths.workspaceDir);
  if (!review.approved) {
    requestChanges(paths, slice, config.reviewCycleCap, review.feedback);
    return;
  }

  if (config.verifyCommand) {
    logRun(paths.runId, `running verify command: ${config.verifyCommand}`);
    const verifyResult = await runVerifyCommand(paths.workspaceDir, config.verifyCommand);
    if (!verifyResult.ok) {
      requestChanges(
        paths,
        slice,
        config.reviewCycleCap,
        `The reviewer approved this slice, but the verify command ("${config.verifyCommand}") failed:\n${verifyResult.detail}`,
      );
      return;
    }
  }

  slice.lastFeedback = undefined;
  slice.status = 'ready_to_merge';
  logRun(paths.runId, `slice "${slice.id}" approved — ready to merge`);
}

function requestChanges(
  paths: RunPaths,
  slice: Slice,
  reviewCycleCap: number,
  feedback: string,
): void {
  slice.reviewCycles += 1;
  slice.lastFeedback = feedback;
  slice.status = slice.reviewCycles >= reviewCycleCap ? 'stuck' : 'pending';
  logRun(paths.runId, `changes requested (cycle ${slice.reviewCycles}/${reviewCycleCap})`);
}

const VERIFY_DETAIL_MAX_LENGTH = 400;

type VerifyResult = { ok: true } | { ok: false; detail: string };

async function runVerifyCommand(cwd: string, verifyCommand: string): Promise<VerifyResult> {
  try {
    // Piped live for the same reason as the agent's own docker call (see
    // docker-cli.ts) — a slow verify command (e.g. a real test suite)
    // would otherwise look identical to a hang until it finally returns.
    const subprocess = execa(verifyCommand, { cwd, shell: true, reject: false });
    subprocess.stdout?.pipe(process.stdout);
    subprocess.stderr?.pipe(process.stderr);
    const result = await subprocess;
    if (result.exitCode !== 0) throw result;
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
