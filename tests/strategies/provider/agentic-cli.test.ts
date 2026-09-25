import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgenticCliProvider } from '../../../src/strategies/provider/agentic-cli.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('AgenticCliProvider', () => {
  it('reports success when the underlying command exits 0', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-provider-'));
    const script = path.join(dir, 'fake-agent.sh');
    await writeFile(script, '#!/bin/sh\necho "got: $@"\nexit 0\n');
    await chmod(script, 0o755);

    const provider = new AgenticCliProvider({ command: script });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('do the thing');
  });

  it('reports failure when the underlying command exits non-zero', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-provider-'));
    const script = path.join(dir, 'fake-agent.sh');
    await writeFile(script, '#!/bin/sh\necho "failing" 1>&2\nexit 1\n');
    await chmod(script, 0o755);

    const provider = new AgenticCliProvider({ command: script });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('failing');
  });

  it('reports an informative failure when the command does not exist', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-provider-'));
    const missingCommand = path.join(dir, 'does-not-exist');

    const provider = new AgenticCliProvider({ command: missingCommand });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(false);
    expect(result.output).not.toBe('');
    expect(result.output.toLowerCase()).toMatch(/enoent|not found|does-not-exist/);
  });

  it('reports an informative failure when the command times out', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-provider-'));
    const script = path.join(dir, 'slow-agent.sh');
    await writeFile(script, '#!/bin/sh\nsleep 5\necho "should not get here"\nexit 0\n');
    await chmod(script, 0o755);

    const provider = new AgenticCliProvider({ command: script, timeoutMs: 50 });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(false);
    expect(result.output).not.toBe('');
    expect(result.output.toLowerCase()).toContain('timed out');
  });
});
