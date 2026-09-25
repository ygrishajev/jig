import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  readStructuredOutput,
  resetStructuredOutput,
  structuredOutputInstruction,
  structuredOutputPath,
} from '../../src/orchestrator/structured-output.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('structured output helper', () => {
  it('builds an instruction that names the expected file', () => {
    expect(structuredOutputInstruction()).toContain('.sdlc-step-output.json');
  });

  it('reads and validates the file the provider wrote', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-output-'));
    const schema = z.object({ approved: z.boolean() });
    await writeFile(structuredOutputPath(dir), JSON.stringify({ approved: true }));
    const result = await readStructuredOutput(dir, (raw) => schema.parse(raw));
    expect(result.approved).toBe(true);
  });

  it('throws a clear error when the file was not written', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-output-'));
    await expect(readStructuredOutput(dir, (raw) => raw)).rejects.toThrow();
  });

  it('reset removes an existing file so a stale result cannot be re-read', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-output-'));
    await writeFile(structuredOutputPath(dir), JSON.stringify({ approved: true }));
    await resetStructuredOutput(dir);
    await expect(readStructuredOutput(dir, (raw) => raw)).rejects.toThrow();
  });

  it('reset is a no-op when no file exists yet', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-output-'));
    await expect(resetStructuredOutput(dir)).resolves.toBeUndefined();
  });
});
