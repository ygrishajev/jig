import { execa } from 'execa';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../tests/support/temp-directory.js';

describe('validation command', () => {
  it('runs selected checks concurrently and prints each complete output together', async () => {
    const { run } = await setup();
    const result = await run(['build', 'lint']);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('build:start\nbuild:end');
    expect(result.all).toContain('lint:start\nlint:end');
  });

  it('skips named checks and waits for other checks after a failure', async () => {
    const { run } = await setup();
    const result = await run(['build', 'lint', 'typecheck', '--skip', 'typecheck'], 'build');
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('lint:end');
    expect(result.all).not.toContain('typecheck:start');
  });

  it.each([
    ['build', 'typo'],
    ['build', '--skip', 'typo'],
  ])('rejects unknown checks before starting any work: %j', async (...args) => {
    const { run } = await setup();
    const result = await run(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.all).not.toContain('build:start');
  });

  it.each([{ args: [] }, { args: ['--skip', 'test:mutation'] }])(
    'defaults to routine checks with arguments %j',
    async ({ args }) => {
      const { run } = await setup();
      const result = await run(args);
      expect(result.exitCode).toBe(0);
      expect(result.all).toContain('secretlint:end');
      expect(result.all).toContain('test:coverage:end');
      expect(result.all).not.toContain('test:mutation:start');
    },
  );

  it('runs mutation testing when explicitly selected', async () => {
    const { run } = await setup();
    const result = await run(['build', 'lint', 'test:mutation']);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('test:mutation:end');
  });

  it('rejects an empty selection', async () => {
    const { run } = await setup();
    const result = await run(['build', '--skip', 'build']);
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('No validation checks selected');
  });

  async function setup() {
    const cwd = await tempDirectory();
    const script = fileURLToPath(new URL('./validate.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
    const scripts = Object.fromEntries(
      [
        'build',
        'lint',
        'typecheck',
        'lint:duplication',
        'format:check',
        'test:coverage',
        'test:mutation',
        'secretlint',
      ].map((name) => [name, `node check.cjs ${name}`]),
    );
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ scripts }));
    await writeFile(
      path.join(cwd, 'check.cjs'),
      `const fs = require('node:fs');
const name = process.argv[2];
fs.writeFileSync(name, 'started');
console.log(name + ':start');
const timer = setInterval(() => {
  if (!fs.existsSync(name === 'build' ? 'lint' : 'build')) return;
  clearInterval(timer);
  console.error(name + ':end');
  process.exit(name === process.env.FAIL_CHECK ? 1 : 0);
}, 10);
setTimeout(() => process.exit(2), 5000).unref();
`,
    );
    return {
      run: (args: string[], failCheck = '') =>
        execa(process.execPath, ['--import', tsx, script, ...args], {
          cwd,
          env: { FAIL_CHECK: failCheck },
          all: true,
          reject: false,
        }),
    };
  }
});
