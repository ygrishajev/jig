import { execa } from 'execa';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tempDirectory } from '../tests/support/temp-directory.js';

describe('npm run lint:dependencies', () => {
  it.each(owners)(
    'rejects %s importing each owner its row leaves out, under its own rule alone',
    async (from) => {
      const forbidden = forbiddenOwners(from);
      const { run } = await setup({ ...targets, [`${from}/a.ts`]: importingEach(forbidden) });

      const result = await run();

      expect(result.exitCode).not.toBe(0);
      expect(reportedErrors(result.all)).toEqual(
        forbidden
          .map(
            (to) => `${from}-imports-only-allowed-owners: src/${from}/a.ts → src/${entryOf(to)}.ts`,
          )
          .sort(),
      );
    },
    30_000,
  );

  it('accepts every owner importing every owner its row allows', async () => {
    const { run } = await setup({ ...targets, ...allowedImports });

    const result = await run();

    expect(result.exitCode, result.all).toBe(0);
  }, 30_000);

  it.each([
    {
      form: 'a type-only import',
      source: "import type { B } from '../adapters/b.js'; export type A = B;",
    },
    { form: 'a re-export', source: "export { b } from '../adapters/b.js';" },
    {
      form: 'a literal dynamic import',
      source: "export const a = () => import('../adapters/b.js');",
    },
  ])(
    'rejects $form from cli into an adapter without an incidental cycle',
    async ({ source }) => {
      const { run } = await setup({ ...targets, 'cli/a.ts': source });

      const result = await run();

      expect(result.exitCode).not.toBe(0);
      expect(reportedErrors(result.all)).toEqual([
        'cli-imports-only-allowed-owners: src/cli/a.ts → src/adapters/b.ts',
      ]);
    },
    30_000,
  );

  it('rejects a nested app file reaching an observer', async () => {
    const { run } = await setup({
      ...targets,
      'app/nested/deeper.ts': importing('../../observers/b.js'),
    });

    const result = await run();

    expect(reportedErrors(result.all)).toEqual([
      'app-imports-only-allowed-owners: src/app/nested/deeper.ts → src/observers/b.ts',
    ]);
  }, 30_000);

  it.each([
    { from: 'cli/a.ts', form: 'production' },
    { from: 'cli/a.spec.ts', form: 'a spec' },
  ])(
    'rejects $form outside app reaching a private app module',
    async ({ from }) => {
      const { run } = await setup({
        ...targets,
        'app/api.ts': "export { b } from './b.js';",
        [from]: importing('../app/b.js'),
      });

      const result = await run();

      expect(result.exitCode).not.toBe(0);
      expect(reportedErrors(result.all)).toEqual([
        `app-internals-are-private-to-app-and-composition: src/${from} → src/app/b.ts`,
      ]);
    },
    30_000,
  );

  it.each(unownedFileCases)(
    'refuses a reintroduced integrations owner under $rule',
    async ({ rule, files }) => {
      const { run } = await setup({ ...targets, ...files });

      const result = await run();

      expect(result.exitCode).not.toBe(0);
      expect(result.all).toMatch(new RegExp(`error ${rule}: .*src/integrations/github/cli[.]ts`));
    },
    30_000,
  );

  it.each(importRuleCases)(
    'rejects $from importing $specifier under $rule',
    async ({ rule, from, specifier }) => {
      const { run } = await setup({ ...targets, [`${from}/a.ts`]: importing(specifier) });

      const result = await run();

      expect(result.exitCode).not.toBe(0);
      expect(result.all).toContain(`error ${rule}: src/${from}/a.ts`);
    },
    30_000,
  );

  it('rejects a runtime cycle between files', async () => {
    const { run } = await setup({
      ...targets,
      'domain/cycle.ts': importing('./cycle-back.js'),
      'domain/cycle-back.ts': importing('./cycle.js'),
    });

    const result = await run();

    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain('error no-runtime-file-cycles: src/domain/');
  }, 30_000);

  it('rejects a cycle between owners, even one only types close', async () => {
    const { run } = await setup({
      ...targets,
      'steps/a.ts': importing('../flow/b.js'),
      'flow/a.ts': "import type { B } from '../steps/b.js'; export type A = B;",
    });

    const result = await run();

    expect(result.exitCode).not.toBe(0);
    expect(result.all).toContain('error no-module-cycles: src/');
  }, 30_000);

  it('has a fixture for every error rule', async () => {
    const { errorRules } = await setup({});

    expect(errorRules.sort()).toEqual(
      [
        ...owners.map((owner) => `${owner}-imports-only-allowed-owners`),
        ...unownedFileCases.map(({ rule }) => rule),
        ...importRuleCases.map(({ rule }) => rule),
        'app-internals-are-private-to-app-and-composition',
        'no-runtime-file-cycles',
        'no-module-cycles',
      ].sort(),
    );
  });

  it('accepts a file cycle broken by type imports', async () => {
    const { run } = await setup({
      'app/api.ts': 'export const api = 1;',
      'domain/a.ts': "import type { B } from './b.js'; export type A = B; export const a = 1;",
      'domain/b.ts': "import { a } from './a.js'; export type B = string; export const b = a;",
    });

    const result = await run();

    expect(result.exitCode, result.all).toBe(0);
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

/** The target-responsibilities table in docs/specs/application-boundaries.md, restated to test the rules against it. */
const ownerTable: Record<string, string[]> = {
  domain: [],
  failures: [],
  ports: ['domain'],
  config: ['domain', 'ports'],
  flow: ['domain', 'ports', 'failures'],
  prompts: ['domain'],
  steps: ['domain', 'ports', 'flow', 'prompts', 'failures'],
  observers: ['domain', 'ports', 'failures'],
  adapters: ['domain', 'ports', 'config', 'observers', 'failures'],
  app: ['domain', 'ports', 'config', 'flow', 'steps', 'prompts', 'failures'],
  cli: ['app', 'domain', 'ports', 'failures'],
  composition: ['app', 'cli', 'adapters', 'config', 'observers', 'ports', 'domain', 'failures'],
};

const owners = Object.keys(ownerTable);

/** Every module a fixture may import; app's public entry stands in for app. */
const targets = {
  ...Object.fromEntries(owners.map((owner) => [`${owner}/b.ts`, target])),
  'app/api.ts': target,
  'app/b.spec.ts': target,
};

const unownedFileCases: { rule: string; files: Record<string, string> }[] = [
  { rule: 'unowned-file-is-disconnected', files: { 'integrations/github/cli.ts': target } },
  {
    rule: 'unowned-file-imports',
    files: { 'integrations/github/cli.ts': importing('../../domain/b.js') },
  },
  {
    rule: 'unowned-file-is-imported',
    files: {
      'integrations/github/cli.ts': target,
      'composition/a.ts': "export { b } from '../integrations/github/cli.js';",
    },
  },
];

const importRuleCases = [
  { rule: 'config-imports-only-approved-dependencies', from: 'config', specifier: 'node:fs' },
  {
    rule: 'failures-imports-only-better-result-and-node',
    from: 'failures',
    specifier: 'commander',
  },
  {
    rule: 'logging-and-tracing-libraries-stay-in-reporting-and-wiring',
    from: 'steps',
    specifier: 'pino',
  },
  { rule: 'no-non-package-json', from: 'app', specifier: 'commander' },
  { rule: 'not-to-dev-dep', from: 'app', specifier: 'vitest' },
  { rule: 'not-to-unresolvable', from: 'app', specifier: './missing.js' },
  { rule: 'not-to-spec', from: 'app', specifier: './b.spec.js' },
];

const allowedImports = Object.fromEntries(
  owners.map((from) => [`${from}/a.ts`, importingEach(ownerTable[from])]),
);

function forbiddenOwners(from: string): string[] {
  return owners.filter((to) => to !== from && !ownerTable[from].includes(to));
}

function importingEach(imported: string[]): string {
  return [
    ...imported.map((to, index) => `import { b as b${index} } from '../${entryOf(to)}.js';`),
    `export const a = [${imported.map((_, index) => `b${index}`).join(', ')}];`,
  ].join('\n');
}

function entryOf(owner: string): string {
  return owner === 'app' ? 'app/api' : `${owner}/b`;
}

/** Each `error <rule>: <from> → <to>` line, without the severity, sorted. */
function reportedErrors(output: string): string[] {
  return [...output.matchAll(/^\s*error (\S+: \S+(?: → \S+)?)/gm)].map(([, line]) => line).sort();
}

function importing(specifier: string) {
  return `import { b } from '${specifier}'; export const a = b;`;
}
