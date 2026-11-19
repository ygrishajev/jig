import { Result } from 'better-result';
import { execa } from 'execa';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const argumentsSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);
const cruiseReportSchema = z.object({
  modules: z.array(
    z.object({
      source: z.string(),
      dependencies: z.array(
        z.object({ resolved: z.string(), couldNotResolve: z.boolean().optional() }),
      ),
    }),
  ),
});

type Edge = readonly [importer: string, imported: string];

const args = argumentsSchema.safeParse(process.argv.slice(2));
if (!args.success) {
  console.error('Usage: node --import tsx scripts/dependency-diff.ts BASE HEAD OUTPUT.svg|--pr');
  process.exitCode = 2;
} else {
  const result = await Result.tryPromise(() => generate(...args.data));
  if (result.isErr()) {
    console.error(result.error.cause);
    process.exitCode = 1;
  }
}

async function generate(base: string, head: string, output: string): Promise<void> {
  const { stdout: repo } = await execa('git', ['rev-parse', '--show-toplevel']);
  const directory = await mkdtemp(join(tmpdir(), 'jig-dependency-diff-'));
  try {
    const before = await cruise(repo, join(directory, 'base'), base);
    const after = await cruise(repo, join(directory, 'head'), head);
    const added = changedEdges(after, before);
    const removed = changedEdges(before, after);
    if (output === '--pr') {
      if (added.length || removed.length) console.log(mermaid(added, removed));
      return;
    }
    await execa('dot', ['-Tsvg', '-o', output], { input: dot(added, removed) });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function cruise(repo: string, snapshot: string, ref: string): Promise<Map<string, Edge>> {
  const { stdout: commit } = await execa('git', [
    '-C',
    repo,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  await mkdir(snapshot);
  await execa('git', ['-C', repo, 'archive', commit]).pipe('tar', ['-x', '-C', snapshot]);
  await symlink(join(repo, 'node_modules'), join(snapshot, 'node_modules'), 'dir');

  const { stdout } = await execa(
    process.execPath,
    [
      join(repo, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
      'src',
      '--no-config',
      '--ts-config',
      'tsconfig.json',
      '--ts-pre-compilation-deps',
      '--include-only',
      '^src/',
      '--output-type',
      'json',
    ],
    { cwd: snapshot },
  );
  const report = cruiseReportSchema.parse(JSON.parse(stdout));
  const imports = report.modules.flatMap(({ source, dependencies }) =>
    dependencies
      .filter(({ resolved, couldNotResolve }) => !couldNotResolve && resolved.startsWith('src/'))
      .map(({ resolved }): Edge => [source, resolved]),
  );
  return new Map(imports.map((edge) => [JSON.stringify(edge), edge]));
}

function changedEdges(snapshot: Map<string, Edge>, other: Map<string, Edge>): Edge[] {
  return [...snapshot.entries()]
    .filter(([key]) => !other.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, edge]) => edge);
}

function mermaid(added: Edge[], removed: Edge[]): string {
  const edges = [...added, ...removed];
  const modules = [...new Set(edges.flat())].sort();
  const nodes = new Map(modules.map((module, index) => [module, `m${index}`]));
  return [
    legend(added, removed),
    '',
    '```mermaid',
    'flowchart LR',
    ...modules.map((module) => `  ${nodes.get(module)}["${mermaidLabel(module)}"]`),
    ...edges.flatMap(([importer, imported], index) => {
      const isAdded = index < added.length;
      return [
        `  ${nodes.get(importer)} ${isAdded ? '-->' : '-.->'} ${nodes.get(imported)}`,
        `  linkStyle ${index} stroke:${isAdded ? '#15803d' : '#b91c1c'},stroke-width:2px`,
      ];
    }),
    '```',
  ].join('\n');
}

function mermaidLabel(module: string): string {
  return Array.from(module.slice(4), (char) =>
    /^[a-zA-Z0-9/._-]$/.test(char) ? char : `#${char.codePointAt(0)};`,
  ).join('');
}

function legend(added: Edge[], removed: Edge[]): string {
  return `${added.length} added (solid green) · ${removed.length} removed (dashed red)`;
}

function dot(added: Edge[], removed: Edge[]): string {
  return [
    'digraph imports {',
    'graph [rankdir=LR, pad=0.2, labelloc=t, fontname="Helvetica"];',
    'node [shape=box, style="rounded", fontname="Helvetica"];',
    `label="${legend(added, removed)}";`,
    ...added.map((edge) => dotEdge(edge, 'color="#15803d"')),
    ...removed.map((edge) => dotEdge(edge, 'color="#b91c1c", style=dashed')),
    '}',
  ].join('\n');
}

function dotEdge([importer, imported]: Edge, style: string): string {
  return `${JSON.stringify(importer.slice(4))} -> ${JSON.stringify(imported.slice(4))} [${style}];`;
}
