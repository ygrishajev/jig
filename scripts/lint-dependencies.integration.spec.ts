import { execa } from 'execa';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tempDirectory } from '../tests/support/temp-directory.js';

describe('npm run lint:dependencies', () => {
  it('rejects a production file breaking any error rule', async () => {
    const { run, errorRules } = await setup({
      ...Object.fromEntries(brokenRules.map(({ from, source }) => [from, source])),
      ...cyclicFiles,
      ...targets,
    });

    const result = await run();

    expect(result.exitCode).not.toBe(0);
    expect([...brokenRules.map(({ rule }) => rule), ...cycleRules].sort()).toEqual(
      errorRules.sort(),
    );
    for (const { rule, from } of brokenRules)
      expect(result.all).toContain(`error ${rule}: src/${from}`);
    for (const rule of cycleRules) expect(result.all).toContain(`error ${rule}: src/`);
  }, 30_000);

  it('rejects a spec outside app reaching a private app module', async () => {
    const { run } = await setup({
      'app/api.ts': "export { b } from './b.js';",
      'app/b.ts': target,
      'cli/a.spec.ts': importing('../app/b.js'),
    });

    const result = await run();

    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain(
      'error app-internals-are-private-to-app-and-composition: src/cli/a.spec.ts → src/app/b.ts',
    );
  }, 30_000);

  it('rejects production app reaching an adapter, observer or the CLI in any form', async () => {
    const { run } = await setup({
      'app/api.ts': 'export const api = 1;',
      'app/direct.ts': importing('../adapters/b.js'),
      'app/nested/deeper.ts': importing('../../observers/b.js'),
      'app/type-only.ts': "import type { B } from '../adapters/b.js'; export type A = B;",
      'app/re-export.ts': "export { b } from '../observers/b.js';",
      'app/dynamic.ts': "export const a = () => import('../adapters/b.js');",
      'app/command.ts': importing('../cli/b.js'),
      'adapters/b.ts': target,
      'observers/b.ts': target,
      'cli/b.ts': target,
    });

    const result = await run();

    expect(result.exitCode).not.toBe(0);
    for (const from of ['direct', 'nested/deeper', 'type-only', 're-export', 'dynamic', 'command'])
      expect(result.all).toContain(`error app-imports-no-infrastructure: src/app/${from}.ts`);
    for (const rule of cycleRules) expect(result.all).not.toContain(`error ${rule}`);
  }, 30_000);

  it('accepts composition wiring adapters, observers and logging into app, and app specs reaching them', async () => {
    const { run } = await setup({
      'ports/b.ts': 'export interface Port { readonly size: number }',
      'app/api.ts': "export { size } from './operation.js';",
      'app/operation.ts': [
        "import type { Port } from '../ports/b.js';",
        'export function size(port: Port): number { return port.size; }',
      ].join('\n'),
      'adapters/b.ts': adapter,
      'observers/b.ts': target,
      'composition/main.ts': [
        "import { pino } from 'pino';",
        "import { size } from '../app/api.js';",
        "import { Adapter } from '../adapters/b.js';",
        "import { b } from '../observers/b.js';",
        'export const wired = () => [size(new Adapter()), b, pino];',
      ].join('\n'),
      'app/operation.spec.ts': [
        "import { Adapter } from '../adapters/b.js';",
        "import { wired } from '../composition/main.js';",
        "import { size } from './operation.js';",
        'export const a = [size(new Adapter()), wired];',
      ].join('\n'),
      'cli/a.spec.ts': "import { size } from '../app/api.js'; export const a = size;",
    });

    const result = await run();

    expect(result.exitCode, result.all).toBe(0);
  }, 30_000);

  it('accepts a file cycle broken by type imports', async () => {
    const { run } = await setup({
      'app/api.ts': 'export const api = 1;',
      'domain/a.ts': "import type { B } from './b.js'; export type A = B; export const a = 1;",
      'domain/b.ts': "import { a } from './a.js'; export type B = string; export const b = a;",
    });

    const result = await run();

    expect(result.exitCode, result.all).toBe(0);
  }, 30_000);

  async function setup(files: Record<string, string>) {
    const cwd = await tempDirectory();
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const { scripts } = packageSchema.parse(
      JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')),
    );
    const { default: configuration } = configurationSchema.parse(
      await import(path.join(repo, '.dependency-cruiser.mjs')),
    );
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        type: 'module',
        scripts,
        dependencies: { pino: '*' },
        devDependencies: { vitest: '*' },
      }),
    );
    await writeFile(
      path.join(cwd, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    );
    for (const shared of [
      'node_modules',
      '.dependency-cruiser.mjs',
      '.dependency-cruiser.specs.mjs',
    ])
      await symlink(path.join(repo, shared), path.join(cwd, shared));
    for (const [file, source] of Object.entries(files)) {
      const destination = path.join(cwd, 'src', file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, source);
    }
    return {
      errorRules: configuration.forbidden
        .filter(({ severity }) => severity === 'error')
        .map(({ name }) => name),
      run: () => execa('npm', ['run', 'lint:dependencies'], { cwd, all: true, reject: false }),
    };
  }
});

const packageSchema = z.object({ scripts: z.record(z.string()) });
const configurationSchema = z.object({
  default: z.object({
    forbidden: z.array(z.object({ name: z.string(), severity: z.string() })),
  }),
});

const target = 'export const b = 1; export type B = string;';
const adapter = 'export class Adapter { readonly size = 1; }';

/** One file per error rule, so a rule that stops matching leaves its own file unreported. */
const brokenRules = [
  broken('domain-is-independent', 'domain/a.ts', '../ports/b.js'),
  broken('ports-depend-only-on-domain', 'ports/a.ts', '../config/b.js'),
  broken('config-imports-only-approved-dependencies', 'config/a.ts', 'node:fs'),
  broken('failures-imports-only-better-result-and-node', 'failures/a.ts', '../domain/b.js'),
  broken('failures-is-imported-only-by-listed-owners', 'prompts/a.ts', '../failures/b.js'),
  broken('adapters-do-not-import-flow', 'adapters/a.ts', '../steps/b.js'),
  broken('flow-does-not-assemble-workflows', 'flow/a.ts', '../steps/b.js'),
  broken('composition-imports-only-allowed-sources', 'composition/a.ts', '../flow/b.js'),
  broken('cli-is-imported-only-by-composition', 'observers/a.ts', '../cli/b.js'),
  broken('composition-is-imported-by-no-other-owner', 'observers/c.ts', '../composition/b.js'),
  broken('app-is-imported-only-by-cli-and-composition', 'steps/a.ts', '../app/api.js'),
  broken('app-internals-are-private-to-app-and-composition', 'cli/a.ts', '../app/b.js'),
  broken('app-public-entry-exposes-no-infrastructure', 'app/api.ts', '../adapters/b.js'),
  {
    rule: 'app-imports-no-infrastructure',
    from: 'app/a.ts',
    source: "import type { B } from '../observers/b.js'; export type A = B;",
  },
  broken('logging-and-tracing-libraries-stay-in-reporting-and-wiring', 'steps/c.ts', 'pino'),
  { rule: 'unowned-file-is-disconnected', from: 'unknown/alone.ts', source: target },
  broken('unowned-file-imports', 'unknown/a.ts', '../domain/b.js'),
  broken('unowned-file-is-imported', 'domain/c.ts', '../unknown/b.js'),
  broken('not-to-unresolvable', 'app/unresolvable.ts', './missing.js'),
  broken('no-non-package-json', 'app/undeclared.ts', 'commander'),
  broken('not-to-dev-dep', 'app/dev-dependency.ts', 'vitest'),
  broken('not-to-spec', 'app/spec.ts', './b.spec.js'),
];

const targets = {
  ...Object.fromEntries(
    [
      'adapters',
      'app',
      'cli',
      'composition',
      'config',
      'domain',
      'failures',
      'flow',
      'observers',
      'ports',
      'steps',
      'unknown',
    ].map((owner) => [`${owner}/b.ts`, target]),
  ),
  'app/b.spec.ts': target,
};

/** Asserted by name alone: dependency-cruiser may report a cycle from any file or folder in it. */
const cycleRules = ['no-module-cycles', 'no-runtime-file-cycles'];

const cyclicFiles = {
  'domain/cycle.ts': importing('./cycle-back.js'),
  'domain/cycle-back.ts': importing('./cycle.js'),
};

function broken(rule: string, from: string, specifier: string) {
  return { rule, from, source: importing(specifier) };
}

function importing(specifier: string) {
  return `import { b } from '${specifier}'; export const a = b;`;
}
