import { z } from 'zod';

import { runIdSchema } from '../../domain/run-id.js';

const requestSchema = z.object({ runId: runIdSchema, text: z.string(), title: z.string() });
export type AcceptedRequest = z.infer<typeof requestSchema>;
const receiptSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  commented: z.boolean().default(false),
});
export type PullRequestReceipt = z.infer<typeof receiptSchema>;
export const orchestrationSchema = z.object({
  version: z.literal(1),
  requests: z.record(requestSchema),
  receipts: z.record(receiptSchema),
});
export type Orchestration = z.infer<typeof orchestrationSchema>;

export function emptyOrchestration(): Orchestration {
  return { version: 1, requests: {}, receipts: {} };
}

export function acceptRequest(
  state: Orchestration,
  key: string,
  request: AcceptedRequest,
): Orchestration {
  return state.requests[key]
    ? state
    : { ...state, requests: { ...state.requests, [key]: request } };
}

export function pullRequestReceipt(
  state: Orchestration,
  key: string,
): PullRequestReceipt | undefined {
  return state.receipts[key];
}

export function withPullRequest(
  state: Orchestration,
  key: string,
  receipt: { number: number; url: string },
): Orchestration {
  if (state.receipts[key]) return state;
  return { ...state, receipts: { ...state.receipts, [key]: { ...receipt, commented: false } } };
}

export function hasCommented(state: Orchestration, key: string): boolean {
  return state.receipts[key]?.commented ?? false;
}

export function withComment(state: Orchestration, key: string): Orchestration {
  const receipt = state.receipts[key];
  if (!receipt || receipt.commented) return state;
  return { ...state, receipts: { ...state.receipts, [key]: { ...receipt, commented: true } } };
}
