import { Result } from 'better-result';
import type { ZodType } from 'zod';

import { AgentOutputInvalid } from '../../ports/agent-session.js';
import { messageOf } from '../exception-details.js';

export function outputInstruction(): string {
  return [
    `When you are completely done, end your reply with your result as a single JSON object`,
    `inside <${OUTPUT_TAG}></${OUTPUT_TAG}> tags, e.g. <${OUTPUT_TAG}>{"key": "value"}</${OUTPUT_TAG}>.`,
    'Do not write the result to a file.',
  ].join(' ');
}

/** The agent ends its reply with this tag around a JSON object; the last one wins. */
export const OUTPUT_TAG = 'jig-output';

/** Reads the last tag in the agent's reply, tolerating a code fence around the JSON and nothing else. */
export function extractOutput<T>(reply: string, schema: ZodType<T>): Result<T, AgentOutputInvalid> {
  const tagged = [
    ...reply.matchAll(new RegExp(`<${OUTPUT_TAG}>([\\s\\S]*?)</${OUTPUT_TAG}>`, 'g')),
  ].at(-1)?.[1];
  if (tagged === undefined) {
    return invalid(`The reply has no <${OUTPUT_TAG}> result.`);
  }
  const raw = Result.try(() => JSON.parse(withoutFence(tagged.trim())) as unknown);
  if (raw.isErr()) {
    return invalid(`The <${OUTPUT_TAG}> result is not valid JSON: ${messageOf(raw.error.cause)}`);
  }
  const parsed = schema.safeParse(raw.value);
  return parsed.success
    ? Result.ok(parsed.data)
    : invalid(`The <${OUTPUT_TAG}> result has the wrong shape: ${parsed.error.message}`);
}

function invalid(message: string): Result<never, AgentOutputInvalid> {
  return Result.err(new AgentOutputInvalid({ message }));
}

function withoutFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : text;
}
