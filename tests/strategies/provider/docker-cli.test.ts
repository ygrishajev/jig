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

  it('mounts host files read-only at the given container paths', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(dir, 'echo "args: $@"\nexit 0\n');
    const credsPath = path.join(dir, 'auth.json');
    await writeFile(credsPath, '{}');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'opencode',
      buildArgs: (prompt) => [prompt],
      hostFileMounts: [
        { hostPath: credsPath, containerPath: '/root/.local/share/opencode/auth.json' },
      ],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).toContain(`-v ${credsPath}:/root/.local/share/opencode/auth.json:ro`);
  });

  it('runs the container as the host uid/gid, with a scratch $HOME', async () => {
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
    expect(result.output).toMatch(new RegExp(`-v \\S+:${SANDBOX_HOME}(?!\\S)`));
  });

  it('pre-creates the parent directory for a host file mount nested under SANDBOX_HOME, before docker runs', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    // Rather than trust a path parsed back out of the args, the fake
    // "docker" checks for the directory itself, at the moment it would
    // actually need to be there — proving the ordering, not just that the
    // mount flag was generated.
    const dockerCommand = await writeFakeDocker(
      dir,
      [
        'args="$@"',
        'scratch=""',
        'prev=""',
        'for a in "$@"; do',
        `  if [ "$prev" = "-v" ]; then`,
        `    case "$a" in *":${SANDBOX_HOME}") scratch="\${a%%:*}" ;; esac`,
        '  fi',
        '  prev="$a"',
        'done',
        'if [ -d "$scratch/.local/share/opencode" ]; then',
        '  echo "PARENT_DIR_EXISTS"',
        'else',
        '  echo "PARENT_DIR_MISSING"',
        'fi',
        'echo "args: $args"',
        'exit 0',
      ].join('\n') + '\n',
    );
    const credsPath = path.join(dir, 'auth.json');
    await writeFile(credsPath, '{}');
    const nestedContainerPath = path.join(SANDBOX_HOME, '.local', 'share', 'opencode', 'auth.json');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'opencode',
      buildArgs: (prompt) => [prompt],
      hostFileMounts: [{ hostPath: credsPath, containerPath: nestedContainerPath }],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).toContain('PARENT_DIR_EXISTS');
    expect(result.output).toContain(`-v ${credsPath}:${nestedContainerPath}:ro`);
  });

  it('opens the scratch $HOME (and any pre-created nested dirs) to any uid, not just the host uid', async () => {
    // Guards against EACCES on a self-hosted runner whose docker remaps the
    // `-u` uid (rootless / userns-remap) so it no longer actually matches
    // the uid that owns these directories on the host side — see the
    // comments in docker-cli.ts. Checked with `ls -ld` (portable across the
    // BSD stat used in local/macOS test runs and the GNU stat in CI) rather
    // than asserting as a different real uid, which the test can't assume.
    dir = await mkdtemp(path.join(tmpdir(), 'sdlc-docker-'));
    const dockerCommand = await writeFakeDocker(
      dir,
      [
        'args="$@"',
        'scratch=""',
        'prev=""',
        'for a in "$@"; do',
        `  if [ "$prev" = "-v" ]; then`,
        `    case "$a" in *":${SANDBOX_HOME}") scratch="\${a%%:*}" ;; esac`,
        '  fi',
        '  prev="$a"',
        'done',
        'echo "home: $(ls -ld "$scratch" | cut -c1-10)"',
        'echo "nested: $(ls -ld "$scratch/.local/share/opencode" | cut -c1-10)"',
        'exit 0',
      ].join('\n') + '\n',
    );
    const credsPath = path.join(dir, 'auth.json');
    await writeFile(credsPath, '{}');
    const nestedContainerPath = path.join(SANDBOX_HOME, '.local', 'share', 'opencode', 'auth.json');

    const provider = new DockerCliProvider({
      image: 'sdlc-agent-sandbox',
      command: 'opencode',
      buildArgs: (prompt) => [prompt],
      hostFileMounts: [{ hostPath: credsPath, containerPath: nestedContainerPath }],
      dockerCommand,
    });
    const result = await provider.run({ cwd: dir, prompt: 'hi' });

    expect(result.output).toContain('home: drwxrwxrwx');
    expect(result.output).toContain('nested: drwxrwxrwx');
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
});
