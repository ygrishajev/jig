import { z } from 'zod';

import { runIdSchema } from '../../domain/run-id.js';
import type { EngineStatus } from '../../flow/engine.js';

export interface CommentIdentity {
  runId: AcceptedRequest['runId'];
  outcome: EngineStatus;
  revision: string;
}

const requestSchema = z.object({ runId: runIdSchema, text: z.string(), title: z.string() });
export type AcceptedRequest = z.infer<typeof requestSchema>;
const receiptSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
});
export type PullRequestReceipt = z.infer<typeof receiptSchema>;
export const orchestrationSchema = z.object({
  version: z.literal(1),
  requests: z.record(requestSchema),
  receipts: z.record(receiptSchema),
  comments: z.record(z.string()).default({}),
});
export type Orchestration = z.infer<typeof orchestrationSchema>;

export function emptyOrchestration(): Orchestration {
  return { version: 1, requests: {}, receipts: {}, comments: {} };
}

export function acceptedRequest(state: Orchestration, key: string): AcceptedRequest | undefined {
  return state.requests[key];
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
  return { ...state, receipts: { ...state.receipts, [key]: receipt } };
}

export function withComment(
  state: Orchestration,
  identity: CommentIdentity,
  url: string,
): Orchestration {
  if (commentReceipt(state, identity)) return state;
  return { ...state, comments: { ...state.comments, [commentKey(identity)]: url } };
}

export function commentReceipt(
  state: Orchestration,
  identity: CommentIdentity,
): string | undefined {
  return state.comments[commentKey(identity)];
}

function commentKey({ runId, outcome, revision }: CommentIdentity): string {
  return `${runId}:${outcome}:${revision}`;
}
