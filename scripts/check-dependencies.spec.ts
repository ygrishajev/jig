import { execa } from 'execa';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../tests/support/temp-directory.js';

const productionOwnersOutsideFailures = [
  'adapters',
  'app',
  'cli',
  'composition',
  'config',
  'domain',
  'flow',
  'integrations',
  'observers',
  'ports',
  'prompts',
  'steps',
];

describe('dependency checking command', () => {
  it('rejects a disconnected two-module cycle containing an erased edge', async () => {
    const { run } = await setup({
      'app/a.ts': "import type { B } from '../adapters/b.js'; export type A = B;",
      'adapters/b.ts': 'export type B = string;',
      'adapters/c.ts': "import { d } from '../app/d.js'; export const c = d;",
      'app/d.ts': 'export const d = 1;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('no-module-cycles: src/app -> src/adapters -> src/app');
    expect(result.all).toContain('src/app/a.ts -> src/adapters/b.ts');
    expect(result.all).toContain('src/adapters/c.ts -> src/app/d.ts');
    expect(result.all).not.toContain('error no-runtime-file-cycles');
  });

  it('aggregates disconnected three-module cycles through nested directories', async () => {
    const { run } = await setup({
      'app/nested/a.ts': "import '../../adapters/b.js';",
      'adapters/b.ts': 'export const b = 1;',
      'adapters/nested/c.ts': "import '../../observers/d.js';",
      'observers/d.ts': 'export const d = 1;',
      'observers/nested/e.ts': "import '../../app/f.js';",
      'app/f.ts': 'export const f = 1;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('no-module-cycles');
    for (const edge of [
      'src/app/nested/a.ts -> src/adapters/b.ts',
      'src/adapters/nested/c.ts -> src/observers/d.ts',
      'src/observers/nested/e.ts -> src/app/f.ts',
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
    ['app', 'cli', 'cli-is-imported-only-by-composition'],
    ['cli', 'composition', 'composition-is-imported-by-no-other-owner'],
    ['composition', 'flow', 'composition-imports-only-allowed-sources'],
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
    "import path from 'node:path'; export const a = path.join;",
    "import { spawn } from 'node:child_process'; export const a = spawn;",
    "import { execa } from 'execa'; export const a = execa;",
    "import type { execa } from 'execa'; export type A = typeof execa;",
    "import writeFileAtomic from 'write-file-atomic'; export const a = writeFileAtomic;",
    "import type { B } from '../../adapters/config/b.js'; export type A = B;",
    "import type { B } from '../../ports/b.js'; export type A = B;",
    "export { b } from '../../app/b.js';",
  ])('rejects production config importing outside its allowlist: %s', async (source) => {
    const { run } = await setup({
      'config/nested/a.ts': source,
      'adapters/config/b.ts': 'export type B = string;',
      'ports/b.ts': 'export type B = string;',
      'app/b.ts': 'export const b = 1;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('config-imports-only-approved-dependencies');
    expect(result.all).toContain('src/config/nested/a.ts');
  });

  it('accepts production config importing config, domain and the approved packages', async () => {
    const { run } = await setup({
      'config/nested/a.ts': [
        "import { Result } from 'better-result';",
        "import { z } from 'zod';",
        "import type { C } from '../c.js';",
        "import { d } from '../../domain/d.js';",
        'export const a = [Result, z, d];',
        'export type A = C;',
      ].join('\n'),
      'config/c.ts': 'export type C = string;',
      'domain/d.ts': 'export const d = 1;',
    });
    expect((await run()).exitCode).toBe(0);
  });

  it('accepts adapters reading config policy and config specs importing I/O and test packages', async () => {
    const { run } = await setup({
      'adapters/config/a.ts': "import { b } from '../../config/b.js'; export const a = b;",
      'config/b.ts': 'export const b = 1;',
      'config/b.spec.ts': [
        "import { readFile } from 'node:fs/promises';",
        "import { execa } from 'execa';",
        "import { b } from './b.js';",
        'export const spec = [readFile, execa, b];',
      ].join('\n'),
    });
    expect((await run()).exitCode).toBe(0);
  });

  it.each(
    ['domain', 'ports', 'config', 'prompts'].flatMap((from) => [
      [from, "import { b } from '../../failures/b.js'; export const a = b;"],
      [from, "import type { B } from '../../failures/b.js'; export type A = B;"],
      [from, "export { b } from '../../failures/b.js';"],
    ]),
  )('rejects %s importing failures: %s', async (from, source) => {
    const { run } = await setup({
      [`${from}/nested/a.ts`]: source,
      'failures/b.ts': 'export const b = 1; export type B = string;',
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('failures-is-imported-only-by-listed-owners');
    expect(result.all).toContain(`src/${from}/nested/a.ts`);
  });

  it.each(
    ['adapters', 'app', 'cli', 'composition', 'flow', 'integrations', 'observers', 'steps'].flatMap(
      (from) => [
        [from, "import { b } from '../../failures/b.js'; export const a = b;"],
        [from, "import type { B } from '../../failures/b.js'; export type A = B;"],
      ],
    ),
  )('accepts %s importing failures: %s', async (from, source) => {
    const { run } = await setup({
      [`${from}/nested/a.ts`]: source,
      'failures/b.ts': 'export const b = 1; export type B = string;',
    });
    expect((await run()).exitCode).toBe(0);
  });

  it.each([
    ...productionOwnersOutsideFailures.flatMap((to) => [
      `import { b } from '../../${to}/b.js'; export const a = b;`,
      `import type { B } from '../../${to}/b.js'; export type A = B;`,
    ]),
    "import { execa } from 'execa'; export const a = execa;",
    "import type { z } from 'zod'; export type A = typeof z;",
  ])('rejects failures importing outside better-result and Node: %s', async (source) => {
    const { run } = await setup({
      'failures/nested/a.ts': source,
      ...Object.fromEntries(
        productionOwnersOutsideFailures.map((owner) => [
          `${owner}/b.ts`,
          'export const b = 1; export type B = string;',
        ]),
      ),
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.all).toContain('failures-imports-only-better-result-and-node');
    expect(result.all).toContain('src/failures/nested/a.ts');
  });

  it.each([
    "import { c } from '../c.js'; export const a = c;",
    "import type { C } from '../c.js'; export type A = C;",
    "import { Result } from 'better-result'; export const a = Result;",
    "import type { Result } from 'better-result'; export type A = Result<string, never>;",
    "import { setTimeout } from 'node:timers/promises'; export const a = setTimeout;",
    "import type { Timeout } from 'node:timers'; export type A = Timeout;",
  ])('accepts failures importing itself, better-result or Node built-ins: %s', async (source) => {
    const { run } = await setup({
      'failures/nested/a.ts': source,
      'failures/c.ts': 'export const c = 1; export type C = string;',
    });
    expect((await run()).exitCode).toBe(0);
  });

  it('accepts a failures spec importing test packages', async () => {
    const { run } = await setup({
      'failures/b.ts': 'export const b = 1;',
      'failures/b.spec.ts': [
        "import { faker } from '@faker-js/faker';",
        "import { execa } from 'execa';",
        "import { expect } from 'vitest';",
        "import { b } from './b.js';",
        'export const spec = [faker, execa, expect, b];',
      ].join('\n'),
    });
    expect((await run()).exitCode).toBe(0);
  });

  it.each(['app', 'adapters', 'config', 'observers', 'ports', 'domain'])(
    'accepts composition importing %s through every import form',
    async (owner) => {
      const { run } = await setup({
        'composition/nested/a.ts': everyImportForm(`../../${owner}/b.js`).join('\n'),
        'composition/deep/nested/a.ts': everyImportForm(`../../../cli/../${owner}/b.js`).join('\n'),
        [`${owner}/b.ts`]: sharedTarget,
      });
      expect((await run()).exitCode).toBe(0);
    },
  );

  it('accepts composition, same-owner, transitional, spec and tooling access to cli', async () => {
    const { cwd, run } = await setup({
      'composition/nested/a.ts': [
        ...everyImportForm('../../cli/b.js'),
        "import { c } from '../c.js';",
        "import { b as failure } from '../../failures/b.js';",
        "import { b as command } from '../../integrations/github/command.js';",
        "import type { B as Port } from '../../integrations/github/github-port.js';",
        'export const composed = [c, failure, command];',
        'export type Composed = Port;',
      ].join('\n'),
      'composition/c.ts': 'export const c = 1;',
      'cli/b.ts': sharedTarget,
      'cli/nested/a.ts': everyImportForm('../b.js').join('\n'),
      'failures/b.ts': sharedTarget,
      'integrations/github/command.ts': everyImportForm('../../cli/b.js').join('\n'),
      'integrations/github/github-port.ts': sharedTarget,
      'app/a.spec.ts': [
        "import { b } from '../cli/b.js';",
        "import { c } from '../composition/c.js';",
        'export const spec = [b, c];',
      ].join('\n'),
    });
    await mkdir(path.join(cwd, 'scripts'));
    await writeFile(
      path.join(cwd, 'scripts/validate.ts'),
      "import { b } from '../src/cli/b.js'; export const tool = b;",
    );
    const result = await run();
    expect(result.exitCode).toBe(0);
  });

  it.each(importFormNames)(
    'rejects every other production owner importing cli through %s',
    async (form) => {
      const importers = {
        ...Object.fromEntries(
          ownersOtherThan('cli', 'composition').map((owner) => [
            `${owner}/nested/a.ts`,
            '../../cli/b.js',
          ]),
        ),
        'integrations/github/implement-issue.ts': '../../cli/b.js',
        'integrations/github/nested/command.ts': '../../../cli/b.js',
        'steps/deep/nested/a.ts': '../../../flow/../cli/b.js',
      };
      const { run } = await setup({
        ...importersUsing(form, importers),
        'cli/b.ts': sharedTarget,
      });
      const result = await run();
      expect(result.exitCode).toBe(1);
      for (const importer of Object.keys(importers))
        expect(result.all).toContain(
          violation('cli-is-imported-only-by-composition', importer, 'cli/b.ts'),
        );
      expect(result.all).not.toContain('no-module-cycles');
    },
  );

  it.each(importFormNames)(
    'rejects every other production owner importing composition through %s',
    async (form) => {
      const importers = {
        ...Object.fromEntries(
          ownersOtherThan('composition').map((owner) => [
            `${owner}/nested/a.ts`,
            '../../composition/b.js',
          ]),
        ),
        'integrations/github/command.ts': '../../composition/b.js',
        'steps/deep/nested/a.ts': '../../../flow/../composition/b.js',
      };
      const { run } = await setup({
        ...importersUsing(form, importers),
        'composition/b.ts': sharedTarget,
      });
      const result = await run();
      expect(result.exitCode).toBe(1);
      for (const importer of Object.keys(importers))
        expect(result.all).toContain(
          violation('composition-is-imported-by-no-other-owner', importer, 'composition/b.ts'),
        );
      expect(result.all).not.toContain('no-module-cycles');
    },
  );

  it.each(importFormNames)(
    'rejects composition importing sources outside its allowlist through %s',
    async (form) => {
      const targets = [
        ...ownersOtherThan(...permittedCompositionDependencies, 'integrations').map(
          (owner) => `${owner}/b.ts`,
        ),
        'integrations/b.ts',
        'integrations/github/octokit-github.ts',
        'integrations/github/nested/command.ts',
      ];
      const importers = Object.fromEntries(
        targets.map((target, index) => [
          `composition/nested/a${index}.ts`,
          `../../${target.replace(/[.]ts$/, '.js')}`,
        ]),
      );
      const { run } = await setup({
        ...importersUsing(form, importers),
        'composition/deep/nested/a.ts': importForms[form]('../../../cli/../flow/b.js'),
        ...Object.fromEntries(targets.map((target) => [target, sharedTarget])),
      });
      const result = await run();
      expect(result.exitCode).toBe(1);
      targets.forEach((target, index) =>
        expect(result.all).toContain(
          violation(
            'composition-imports-only-allowed-sources',
            `composition/nested/a${index}.ts`,
            target,
          ),
        ),
      );
      expect(result.all).toContain(
        violation(
          'composition-imports-only-allowed-sources',
          'composition/deep/nested/a.ts',
          'flow/b.ts',
        ),
      );
      expect(result.all).not.toContain('no-module-cycles');
    },
  );

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

  it('scans all thirteen owners including disconnected files', async () => {
    const owners = [...productionOwnersOutsideFailures, 'failures'];
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
    const declaredPackages = ['better-result', 'execa', 'write-file-atomic', 'zod'].map((name) => [
      name,
      '*',
    ]);
    await writeFile(
      path.join(cwd, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext' } }),
    );
    const testPackages = ['@faker-js/faker', 'vitest'].map((name) => [name, '*']);
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: Object.fromEntries(declaredPackages),
        devDependencies: Object.fromEntries(testPackages),
      }),
    );
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(cwd, 'node_modules'),
    );
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(cwd, 'src', file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    const script = fileURLToPath(new URL('./check-dependencies.mjs', import.meta.url));
    return { cwd, run: () => execa(process.execPath, [script], { cwd, all: true, reject: false }) };
  }
});

/** The owners composition may import besides the two transitional GitHub sources. */
const permittedCompositionDependencies = [
  'composition',
  'cli',
  'app',
  'adapters',
  'config',
  'observers',
  'ports',
  'domain',
  'failures',
];

const sharedTarget = 'export const b = 1; export type B = string;';

const importForms = {
  'a value import': (specifier: string) => `import { b } from '${specifier}'; export const a = b;`,
  'an erased type import': (specifier: string) =>
    `import type { B } from '${specifier}'; export type A = B;`,
  'a re-export': (specifier: string) => `export { b } from '${specifier}';`,
  'a literal dynamic import': (specifier: string) =>
    `export const a = () => import('${specifier}');`,
};
type ImportForm = keyof typeof importForms;
const importFormNames = Object.keys(importForms) as ImportForm[];

function everyImportForm(specifier: string) {
  return [
    `import { b as value } from '${specifier}';`,
    `import type { B } from '${specifier}';`,
    `export { b as reexported } from '${specifier}';`,
    `export const lazy = () => import('${specifier}');`,
    'export const imported = value;',
    'export type Imported = B;',
  ];
}

function importersUsing(form: ImportForm, importers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(importers).map(([file, specifier]) => [file, importForms[form](specifier)]),
  );
}

function ownersOtherThan(...excluded: string[]) {
  return [...productionOwnersOutsideFailures, 'failures'].filter(
    (owner) => !excluded.includes(owner),
  );
}

function violation(rule: string, from: string, to: string) {
  return `error ${rule}: src/${from} → src/${to}`;
}
