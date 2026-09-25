import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownFileInputSource } from '../../../src/strategies/input-source/markdown-file.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('MarkdownFileInputSource', () => {
  it('resolves the file contents', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-input-'));
    const filePath = path.join(dir, 'request.md');
    await writeFile(filePath, '# Add feature X\n\nDetails here.');
    const source = new MarkdownFileInputSource(filePath);
    expect(await source.resolve()).toContain('Add feature X');
  });

  it('throws a clear error when the file does not exist', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-input-'));
    const source = new MarkdownFileInputSource(path.join(dir, 'missing.md'));
    await expect(source.resolve()).rejects.toThrow();
  });
});
