import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { DockerCliProvider, SANDBOX_HOME } from '../../../src/strategies/provider/docker-cli.js';

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
  it('mounts cwd, sets the workdir, and places the prompt where buildArgs puts it', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      buildArgs: (prompt) => ['-p', prompt, '--output-format', 'text'],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(true);
    expect(result.output).toContain(`-v ${dir}:/workspace`);
    expect(result.output).toContain('-w /workspace');
    expect(result.output).toContain(
      'sdlc-agent-sandbox claude -p do the thing --output-format text',
    );
  });

  it('supports a prompt placed mid-argument-list, not just trailing (e.g. opencode-style)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'opencode',
      buildArgs: (prompt) => ['run', prompt, '--format', 'json', '--auto'],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.output).toContain(
      'sdlc-agent-sandbox opencode run do the thing --format json --auto',
    );
  });

  it('passes named host environment variables through to -e flags, in order', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');
    process.env.SDLC_TEST_TOKEN = 'secret-token-value';

    try {
      const provider = new DockerCliProvider({
        image: 'sdlc-agent-sandbox',
        command: 'claude',
        buildArgs: (prompt) => [prompt],
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
      buildArgs: (prompt) => [prompt],
      envVarsFromHost: ['SDLC_TEST_UNSET_TOKEN'],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).not.toContain('SDLC_TEST_UNSET_TOKEN');
  });

  it("reads a host file's contents and passes them into the container as an env var", async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');
    const credsPath = path.join(dir, 'auth.json');
    await writeFile(credsPath, '{"key":"secret"}');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'opencode',
      buildArgs: (prompt) => [prompt],
      hostEnvFileMounts: [{ hostPath: credsPath, envVarName: 'OPENCODE_AUTH_JSON' }],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).toContain('-e OPENCODE_AUTH_JSON={"key":"secret"}');
  });

  it("defaults to docker's own pull policy (missing), so a locally built image isn't re-pulled", async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      buildArgs: (prompt) => [prompt],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).toContain('--pull missing');
  });

  it("re-pulls on every run when pullPolicy is 'always', so a self-hosted runner's cached image doesn't go stale", async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');

    const provider = new DockerCliProvider({
      image: 'ghcr.io/example/sdlc-agent-sandbox:latest',
      command: 'claude',
      buildArgs: (prompt) => [prompt],
      pullPolicy: 'always',
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).toContain('--pull always');
  });

  it('runs the container as the host uid/gid, with $HOME on a tmpfs', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      buildArgs: (prompt) => [prompt],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    const { uid, gid } = os.userInfo();
    expect(result.output).toContain(`-u ${uid}:${gid}`);
    expect(result.output).toContain(`-e HOME=${SANDBOX_HOME}`);
    expect(result.output).toContain(`--tmpfs ${SANDBOX_HOME}:mode=1777`);
  });

  it('reports failure when the container exits non-zero', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "failing" 1>&2\nexit 1\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'claude',
      buildArgs: (prompt) => [prompt],
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
      buildArgs: (prompt) => [prompt],
      dockerCommand: missingDocker,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.success).toBe(false);
    expect(result.output).not.toBe('');
    expect(result.output.toLowerCase()).toMatch(/enoent|not found|does-not-exist/);
  });

  it('reports a clear failure when a host env file mount does not exist', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'opencode',
      buildArgs: (prompt) => [prompt],
      hostEnvFileMounts: [
        { hostPath: path.join(dir, 'does-not-exist.json'), envVarName: 'OPENCODE_AUTH_JSON' },
      ],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.success).toBe(false);
    expect(result.output.toLowerCase()).toMatch(/enoent/);
  });
});
