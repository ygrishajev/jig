import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DockerCliProvider } from '../../../src/strategies/provider/docker-cli.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function writeFakeDocker(dir: string, body: string): Promise<string> {
  const script = path.join(dir, 'fake-docker.sh');
  await writeFile(script, `#!/bin/sh\n${body}`);
  await chmod(script, 0o755);
  return script;
}

describe('DockerCliProvider', () => {
  it('mounts cwd, sets the workdir, and passes the prompt as the final argument', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      args: ['-p'],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(true);
    expect(result.output).toContain(`-v ${dir}:/workspace`);
    expect(result.output).toContain('-w /workspace');
    expect(result.output).toContain('sdlc-agent-sandbox claude -p do the thing');
  });

  it('passes named host environment variables through to -e flags, in order', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');
    process.env.SDLC_TEST_TOKEN = 'secret-token-value';

    try {
      const provider = new DockerCliProvider({
        image: 'sdlc-agent-sandbox',
        command: 'claude',
        envVarsFromHost: ['SDLC_TEST_TOKEN'],
        dockerCommand,
      });
      const result = await provider.run({ cwd: dir, prompt: 'hi' });

      expect(result.output).toContain('-e SDLC_TEST_TOKEN=secret-token-value');
    } finally {
      delete process.env.SDLC_TEST_TOKEN;
    }
  });

  it('omits an -e flag for a host env var that is not set', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');
    delete process.env.SDLC_TEST_UNSET_TOKEN;

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      envVarsFromHost: ['SDLC_TEST_UNSET_TOKEN'],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).not.toContain('SDLC_TEST_UNSET_TOKEN');
  });

  it('reports failure when the container exits non-zero', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "failing" 1>&2\nexit 1\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('failing');
  });

  it('reports an informative failure when the docker binary does not exist', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const missingDocker = path.join(dir, 'does-not-exist');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      dockerCommand: missingDocker,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.success).toBe(false);
    expect(result.output).not.toBe('');
    expect(result.output.toLowerCase()).toMatch(/enoent|not found|does-not-exist/);
  });
});
