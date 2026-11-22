import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../tests/support/temp-directory.js';

describe('dependency checking command', () => {
  it('rejects a disconnected two-module cycle containing an erased edge', async () => {
    const { run } = await setup({
      'app/a.ts': "import type { B } from '../config/b.js'; export type A = B;",
      'config/b.ts': 'export type B = string;',
      'config/c.ts': "import { d } from '../app/d.js'; export const c = d;",
      'app/d.ts': 'export const d = 1;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('no-module-cycles: src/app -> src/config -> src/app');
    expect(result.all).toContain('src/app/a.ts -> src/config/b.ts');
    expect(result.all).toContain('src/config/c.ts -> src/app/d.ts');
    expect(result.all).not.toContain('error no-runtime-file-cycles');
  });

  it('aggregates disconnected three-module cycles through nested directories', async () => {
    const { run } = await setup({
      'app/nested/a.ts': "import '../../adapters/b.js';",
      'adapters/b.ts': 'export const b = 1;',
      'adapters/nested/c.ts': "import '../../config/d.js';",
      'config/d.ts': 'export const d = 1;',
      'config/nested/e.ts': "import '../../app/f.js';",
      'app/f.ts': 'export const f = 1;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('no-module-cycles');
    for (const edge of [
      'src/app/nested/a.ts -> src/adapters/b.ts',
      'src/adapters/nested/c.ts -> src/config/d.ts',
      'src/config/nested/e.ts -> src/app/f.ts',
    ])
      expect(result.all).toContain(edge);
  });

  it('accepts acyclic type imports', async () => {
    const { run } = await setup({
      'app/a.ts': "import type { B } from '../domain/b.js'; export type A = B;",
      'domain/b.ts': 'export type B = string;',
    });
    expect((await run()).exitCode).toBe(0);
  });

  it('rejects intra-module runtime cycles', async () => {
    const { run } = await setup({
      'app/a.ts': "import './b.js'; export const a = 1;",
      'app/b.ts': "import './a.js'; export const b = 1;",
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain(
      'no-runtime-file-cycles: src/app/a.ts -> src/app/b.ts -> src/app/a.ts',
    );
  });

  it.each([
    "import type { B } from './b.js'; export type A = B;",
    "import './b.js'; export type A = string;",
  ])('accepts intra-module cycles broken by erasure: %s', async (source) => {
    const { run } = await setup({
      'domain/a.ts': source,
      'domain/b.ts': "import type { A } from './a.js'; export type B = A;",
    });
    expect((await run()).exitCode).toBe(0);
  });

  it.each([
    ['domain', 'ports', 'domain-is-independent'],
    ['ports', 'config', 'ports-depend-only-on-domain'],
    ['adapters', 'flow', 'adapters-do-not-import-flow'],
    ['flow', 'app', 'flow-does-not-assemble-workflows'],
    ['flow', 'steps', 'flow-does-not-assemble-workflows'],
    ['app', 'integrations/github', 'github-is-isolated'],
  ])('rejects type imports from %s to %s', async (from, to, rule) => {
    const specifier = path.posix.relative(from, `${to}/b.js`);
    const { run } = await setup({
      [`${from}/a.ts`]: `import type { B } from '${specifier}'; export type A = B;`,
      [`${to}/b.ts`]: 'export type B = string;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain(rule);
    expect(result.all).toContain(`src/${from}/a.ts`);
    expect(result.all).toContain(`src/${to}/b.ts`);
  });

  it.each([
    "import { readFileSync } from 'node:fs'; export const a = readFileSync;",
    "import { readFile } from 'node:fs/promises'; export const a = readFile;",
    "import { readFile } from 'fs/promises'; export const a = readFile;",
    "import { homedir } from 'node:os'; export const a = homedir;",
    "import type { B } from '../../adapters/config/b.js'; export type A = B;",
  ])('rejects config reaching for I/O: %s', async (source) => {
    const { run } = await setup({
      'config/nested/a.ts': source,
      'adapters/config/b.ts': 'export type B = string;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('config-does-no-io');
    expect(result.all).toContain('src/config/nested/a.ts');
  });

  it('accepts adapters that read config policy and config that resolves paths', async () => {
    const { run } = await setup({
      'adapters/config/a.ts': "import { b } from '../../config/b.js'; export const a = b;",
      'config/b.ts': "import path from 'node:path'; export const b = path.join('a', 'b');",
    });
    expect((await run()).exitCode).toBe(0);
  });

  it.each(['unknown/a.ts', 'stray.ts', 'app-other/a.ts'])(
    'rejects unowned production file %s',
    async (file) => {
      const { run } = await setup({ [file]: 'export const a = 1;' });
      const result = await run();
      expect(result.exitCode).toBe(1);
      expect(result.all).toContain(`unowned-production-file: src/${file}`);
    },
  );

  it('rejects production imports of specs while excluding standalone specs', async () => {
    const { run } = await setup({
      'app/a.ts': "import './a.spec.js';",
      'app/a.spec.ts': 'export const a = 1;',
      'unknown/ignored.spec.ts': "import './missing.js';",
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('not-to-spec');
    expect(result.all).not.toContain('unowned-production-file: src/unknown/ignored.spec.ts');
  });

  it('scans all eleven owners including disconnected files', async () => {
    const owners = [
      'adapters',
      'app',
      'cli',
      'config',
      'domain',
      'flow',
      'integrations',
      'observers',
      'ports',
      'prompts',
      'steps',
    ];
    const { run } = await setup(
      Object.fromEntries(owners.map((owner) => [`${owner}/a.ts`, "import './missing.js';"])),
    );
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('not-to-unresolvable');
    for (const owner of owners) expect(result.all).toContain(`src/${owner}/a.ts`);
  });

  async function setup(files: Record<string, string>) {
    const cwd = await tempDirectory();
    await writeFile(
      path.join(cwd, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    );
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(cwd, 'src', file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    const script = fileURLToPath(new URL('./check-dependencies.mjs', import.meta.url));
    return { run: () => execa(process.execPath, [script], { cwd, all: true, reject: false }) };
  }
});
