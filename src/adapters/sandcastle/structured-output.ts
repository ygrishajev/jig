import type { ZodType } from 'zod';

import { AgentOutputInvalid, messageOf } from '../../domain/errors.js';

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
export function extractOutput<T>(reply: string, schema: ZodType<T>): T {
  const tagged = [
    ...reply.matchAll(new RegExp(`<${OUTPUT_TAG}>([\\s\\S]*?)</${OUTPUT_TAG}>`, 'g')),
  ].at(-1)?.[1];
  if (tagged === undefined) {
    throw new AgentOutputInvalid({ message: `The reply has no <${OUTPUT_TAG}> result.` });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(withoutFence(tagged.trim()));
  } catch (error) {
    throw new AgentOutputInvalid({
      message: `The <${OUTPUT_TAG}> result is not valid JSON: ${messageOf(error)}`,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentOutputInvalid({
      message: `The <${OUTPUT_TAG}> result has the wrong shape: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

function withoutFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : text;
}
