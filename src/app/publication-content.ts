import type { Refusal } from '../domain/orchestration.js';
import { runBranchFor } from '../domain/run-state.js';
import type { OpenPullRequest } from '../ports/github.js';
import { stuckReason } from './findings-comment.js';
import type { RunReport } from './run-jig.js';

/** The issue comment for a run that published no PR: how it ended and why. */
export function statusCommentBody(report: RunReport): string {
  return `Run ${report.state.runId}: ${report.status}. ${statusCommentReason(report)}`;
}

function statusCommentReason(report: RunReport): string {
  switch (report.status) {
    case 'blocked':
      return report.reason;
    case 'halted':
      return 'Paused at the design checkpoint.';
    case 'stuck':
      return stuckReason(report.state);
    case 'completed':
    case 'done':
      return 'No changes were committed.';
  }
}

/** The issue comment for a revision jig refused to publish, naming every refused path. */
export function refusalCommentBody({ runId, revision, paths }: Refusal): string {
  const listed = paths.map((path) => `- \`${path}\``).join('\n');
  return `Run ${runId} was not published: revision ${revision} changes GitHub workflows, which jig does not push for review.\n\n${listed}`;
}

/** The PR a run's branch is offered as, closing the issue it was accepted from. */
export function pullRequestFor(
  report: RunReport,
  { title, issueNumber, draft }: { title: string; issueNumber: number; draft: boolean },
): OpenPullRequest {
  return {
    head: runBranchFor(report.state.runId),
    base: report.state.baseBranch,
    title,
    body: `${report.state.prDescription ?? ''}\n\nCloses #${issueNumber}`,
    draft,
  };
}
