import { readFile } from 'node:fs/promises';
import type { InputSource } from './types.js';

export class MarkdownFileInputSource implements InputSource {
  constructor(private readonly filePath: string) {}

  async resolve(): Promise<string> {
    return readFile(this.filePath, 'utf-8');
  }
}
