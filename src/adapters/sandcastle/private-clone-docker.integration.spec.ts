import { faker } from '@faker-js/faker';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { simpleGit } from 'simple-git';
import { describe, expect, it, vi } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { GitCommandFailed } from '../../ports/git-failures.js';
import { type DockerCli, privateCloneDocker, shellQuote } from './private-clone-docker.js';

describe('privateCloneDocker', () => {
  it('starts the container with nothing from the repository mounted', async () => {
    const { create, runArguments, repo } = await setup();

    await create();

    const args = await runArguments();
    expect(args.filter((arg) => arg === '-v' || arg === '--mount')).toEqual([]);
    expect(args.join(' ')).not.toContain(repo);
  });

  it('ignores the mounts sandcastle offers', async () => {
    const { create, runArguments } = await setup();
    const offered = path.join(faker.system.directoryPath(), faker.string.alphanumeric(16));

    await create([{ hostPath: offered, sandboxPath: offered }]);

    expect((await runArguments()).join(' ')).not.toContain(offered);
  });

  it('mounts the login directory when there is one, and only that', async () => {
    const loginDirectory = await tempDirectory();
    const { create, runArguments } = await setup({ loginDirectory });

    await create();

    const args = await runArguments();
    expect(args.filter((arg) => arg === '-v')).toHaveLength(1);
    expect(args).toContain(`${loginDirectory}:/home/agent/.codex:z`);
  });

  it('passes the environment and a jig identity that overrides any git config', async () => {
    const value = faker.string.alphanumeric(12);
    const { create, runArguments } = await setup();

    await create([], { SOME_KEY: value });

    const args = await runArguments();
    expect(args).toContain(`SOME_KEY=${value}`);
    expect(args).toContain('GIT_AUTHOR_NAME=jig');
    expect(args).toContain('GIT_COMMITTER_NAME=jig');
  });

  it('hands the sandbox a bundle holding only the run and base branches', async () => {
    const { create, bundleRefs, branch, repo } = await setup();
    await simpleGit({ baseDir: repo }).branch([faker.string.alpha({ length: 8, casing: 'lower' })]);

    await create();

    expect(await bundleRefs()).toEqual([`refs/heads/${branch}`, 'refs/heads/main'].sort());
  });

  it("copies the host's excludes into the clone", async () => {
    const { create, repo, stdinFor } = await setup();
    const local = faker.string.alpha(10);
    const configured = faker.string.alpha(10);
    const excludesFile = path.join(await tempDirectory(), 'ignore');
    await writeFile(path.join(repo, '.git', 'info', 'exclude'), `${local}\n`);
    await writeFile(excludesFile, `${configured}\n`);
    await simpleGit({ baseDir: repo }).addConfig('core.excludesFile', excludesFile);

    await create();

    const excludes = stdinFor('info/exclude');
    expect(excludes).toContain(local);
    expect(excludes).toContain(configured);
  });

  it('removes the container when preparing the clone fails', async () => {
    const { create, docker } = await setup({ failing: 'git clone' });

    await expect(create()).rejects.toThrow();

    expect(docker.remove).toHaveBeenCalledOnce();
  });

  it('removes the container on close', async () => {
    const { create, docker } = await setup();
    const handle = await create();

    await handle.close();

    expect(docker.remove).toHaveBeenCalledOnce();
  });

  it('runs commands in the clone by default, feeding lines and stdin through', async () => {
    const { create, docker } = await setup();
    const handle = await create();
    const onLine = vi.fn();
    const stdin = faker.lorem.sentence();

    await handle.exec('true', { onLine, stdin });

    const call = vi.mocked(docker.run).mock.lastCall;
    expect(call?.[0]).toEqual(
      expect.arrayContaining(['-i', '-w', handle.worktreePath, 'sh', '-c', 'true']),
    );
    expect(call?.[1]).toMatchObject({ stdin, onLine });
  });

  it('starts a detached, named container as the host user, from the image', async () => {
    const { create, runArguments, imageName, containerName } = await setup();

    await create();

    const args = await runArguments();
    expect(args.slice(0, 5)).toEqual(['run', '-d', '--name', containerName(), '--user']);
    expect(args[5]).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
    expect(args.at(-1)).toBe(imageName);
  });

  it('does everything else in that container', async () => {
    const { create, docker, containerName } = await setup();

    const handle = await create();
    await handle.exec('true');

    for (const [args] of vi.mocked(docker.run).mock.calls.slice(1)) {
      expect(args[0]).toBe('exec');
      expect(args).toContain(containerName());
    }
    expect(vi.mocked(docker.copyIn).mock.calls[0][1]).toBe(`${containerName()}:/tmp/in.bundle`);
  });

  it('clones from the filesystem root, since the workspace does not exist yet', async () => {
    const { create, docker } = await setup();

    await create();

    const cloneCall = vi
      .mocked(docker.run)
      .mock.calls.find(([args]) => args.at(-1)?.includes('git clone'));
    expect(cloneCall?.[0].slice(1, 3)).toEqual(['-w', '/']);
  });

  it('leaves no copy of the bundle on the host', async () => {
    const { create, docker } = await setup();

    await create();

    expect(existsSync(path.dirname(vi.mocked(docker.copyIn).mock.calls[0][0]))).toBe(false);
  });

  it('keeps stdin open only for a command that has some', async () => {
    const { create, docker } = await setup();
    const handle = await create();

    await handle.exec('true');

    expect(vi.mocked(docker.run).mock.lastCall?.[0]).not.toContain('-i');
  });

  it('runs a command with sudo when sandcastle asks for it', async () => {
    const { create, docker } = await setup();
    const handle = await create();
    const command = faker.word.verb();

    await handle.exec(command, { sudo: true });

    expect(vi.mocked(docker.run).mock.lastCall?.[0].at(-1)).toBe(`sudo ${command}`);
  });

  it('copies files for sandcastle the same way, rejecting when a copy fails', async () => {
    const bytes = Buffer.from(faker.string.alphanumeric(16));
    const directory = await tempDirectory();
    const { create, docker, containerName } = await setup({ streamed: [bytes] });
    const handle = await create();
    const hostFile = path.join(directory, faker.string.uuid());
    const sandboxFile = faker.system.filePath();

    await handle.copyFileOut(sandboxFile, hostFile);
    await expect(handle.copyFileOut(sandboxFile, hostFile)).rejects.toBeInstanceOf(
      GitCommandFailed,
    );
    await handle.copyFileIn(hostFile, sandboxFile);

    expect(await readFile(hostFile)).toEqual(bytes);
    expect(vi.mocked(docker.copyIn).mock.lastCall).toEqual([
      hostFile,
      `${containerName()}:${sandboxFile}`,
    ]);
  });

  it('quotes arguments so a shell passes them through unchanged', async () => {
    const argument = `it's "$HOME" \\ ; ${faker.lorem.word()}`;

    const { stdout } = await execa('sh', ['-c', `printf %s ${shellQuote(argument)}`]);

    expect(stdout).toBe(argument);
  });

  it('copies bytes into a new private file', async () => {
    const bytes = Buffer.from(faker.string.alphanumeric(64));
    const target = path.join(await tempDirectory(), 'out.bundle');
    const { clone } = await setup({ streamed: [bytes] });

    (await clone.copyOut('.git/out.bundle', target)).unwrap();

    expect(await readFile(target)).toEqual(bytes);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it('refuses to copy over a file that already exists', async () => {
    const target = path.join(await tempDirectory(), 'out.bundle');
    const original = faker.lorem.sentence();
    await writeFile(target, original);
    const { clone } = await setup({ streamed: [Buffer.from(faker.lorem.word())] });

    const copied = await clone.copyOut('.git/out.bundle', target);

    expect(copied.isErr() && copied.error).toBeInstanceOf(GitCommandFailed);
    expect(await readFile(target, 'utf-8')).toBe(original);
  });

  it('stops copying past the size limit and leaves no file', async () => {
    const target = path.join(await tempDirectory(), 'out.bundle');
    const { clone } = await setup({
      streamed: [Buffer.alloc(32), Buffer.alloc(32)],
      copyLimit: 40,
    });

    const copied = await clone.copyOut('.git/out.bundle', target);

    expect(copied.isErr() && copied.error).toBeInstanceOf(GitCommandFailed);
    expect(existsSync(target)).toBe(false);
  });

  it('reports a copy the sandbox could not read', async () => {
    const target = path.join(await tempDirectory(), 'out.bundle');
    const { clone } = await setup({ streamed: [], streamExitCode: 1 });

    const copied = await clone.copyOut('.git/out.bundle', target);

    expect(copied.isErr() && copied.error).toBeInstanceOf(GitCommandFailed);
    expect(existsSync(target)).toBe(false);
  });

  async function setup(
    input: {
      loginDirectory?: string;
      failing?: string;
      streamed?: Buffer[];
      streamExitCode?: number;
      copyLimit?: number;
    } = {},
  ) {
    const { dir: repo } = await createTempRepo();
    const branch = `jig/run/${faker.string.alpha({ length: 8, casing: 'lower' })}`;
    const git = simpleGit({ baseDir: repo });
    await git.branch([branch]);
    const stdins: { command: string; stdin?: string }[] = [];
    const copied: string[] = [];
    let refs: string[] = [];
    const docker: DockerCli = {
      run: vi.fn<DockerCli['run']>(async (args, options) => {
        const command = args.at(-1) ?? '';
        stdins.push({ command, stdin: options?.stdin });
        const failed = input.failing !== undefined && command.includes(input.failing);
        return { exitCode: failed ? 1 : 0, stdout: '', stderr: failed ? 'failed' : '' };
      }),
      copyIn: vi.fn<DockerCli['copyIn']>(async (hostPath) => {
        if (!hostPath.endsWith('.bundle')) return;
        const listed = await git.raw(['bundle', 'list-heads', hostPath]);
        refs = listed
          .trim()
          .split('\n')
          .map((line) => line.split(' ')[1])
          .sort();
        copied.push(hostPath);
      }),
      stream: vi.fn<DockerCli['stream']>(() => ({
        stdout: Readable.from(input.streamed ?? []),
        finished: Promise.resolve(input.streamExitCode ?? 0),
      })),
      remove: vi.fn<DockerCli['remove']>(async () => undefined),
      removeOnExit: vi.fn<DockerCli['removeOnExit']>(() => () => undefined),
    };
    const imageName = `sandcastle:${faker.word.noun()}`;
    const clone = privateCloneDocker({
      imageName,
      branch,
      baseBranch: 'main',
      loginDirectory: input.loginDirectory,
      docker,
      copyLimitBytes: input.copyLimit,
    });
    const create = (
      mounts: { hostPath: string; sandboxPath: string }[] = [],
      env: Record<string, string> = {},
    ) =>
      clone.create({ worktreePath: faker.system.directoryPath(), hostRepoPath: repo, mounts, env });
    const runArguments = async () => vi.mocked(docker.run).mock.calls[0][0];
    const containerName = () => vi.mocked(docker.run).mock.calls[0][0][3];
    const stdinFor = (fragment: string) =>
      stdins.find((entry) => entry.command.includes(fragment))?.stdin ?? '';
    return {
      imageName,
      containerName,
      clone,
      create,
      docker,
      repo,
      branch,
      runArguments,
      stdinFor,
      bundleRefs: async () => refs,
    };
  }
});
