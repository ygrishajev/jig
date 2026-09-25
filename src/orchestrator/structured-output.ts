import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export const STRUCTURED_OUTPUT_FILENAME = '.sdlc-step-output.json';

export function structuredOutputPath(cwd: string): string {
  return path.join(cwd, STRUCTURED_OUTPUT_FILENAME);
}

export function structuredOutputInstruction(): string {
  return [
    `When you are completely done, write your result as a single JSON object to the file`,
    `"${STRUCTURED_OUTPUT_FILENAME}" in the current directory. Do not wrap it in markdown`,
    `code fences and do not include any other content in that file.`,
  ].join(' ');
}

export async function resetStructuredOutput(cwd: string): Promise<void> {
  await rm(structuredOutputPath(cwd), { force: true });
}

export async function readStructuredOutput<T>(cwd: string, parse: (raw: unknown) => T): Promise<T> {
  const raw = JSON.parse(await readFile(structuredOutputPath(cwd), 'utf-8'));
  return parse(raw);
}
