import { describe, expect, it } from 'vitest';
import { buildCli } from '../../src/cli/main.js';

describe('buildCli', () => {
  it('exposes the sdlc program name', () => {
    const program = buildCli();
    expect(program.name()).toBe('sdlc');
  });
});
