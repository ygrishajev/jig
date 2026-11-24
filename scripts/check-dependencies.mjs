import { panic, Result } from 'better-result';
import { allExtensions, cruise, format } from 'dependency-cruiser';
import console from 'node:console';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

import configuration, {
  ownedProductionPath,
  publicApplicationSource,
  publicDeclarationRules,
  specRules,
  testFilePattern,
} from '../.dependency-cruiser.mjs';

const entries = await Result.tryPromise(() =>
  readdir('src', { recursive: true, withFileTypes: true }),
);
if (entries.isErr()) {
  console.error(`Cannot scan production sources: ${entries.error.cause}`);
  process.exitCode = 1;
} else {
  const extensions = new Set(
    allExtensions.filter(({ available }) => available).map(({ extension }) => extension),
  );
  const sources = entries.value
    .filter((entry) => entry.isFile() && extensions.has(extname(entry.name)))
    .map((entry) => `${entry.parentPath}/${entry.name}`);
  const isSpec = (file) => new RegExp(testFilePattern).test(file);
  const files = sources.filter((file) => !isSpec(file));
  const specs = sources.filter(isSpec);
  const unowned = files.filter((file) => !new RegExp(ownedProductionPath).test(file));
  for (const file of unowned) console.error(`unowned-production-file: ${file}`);
  const architecture = await inspect(files, configuration);
  const runtime = await inspect(files, {
    ...configuration,
    forbidden: [
      { name: 'no-runtime-file-cycles', severity: 'error', from: {}, to: { circular: true } },
    ],
    options: { ...configuration.options, tsPreCompilationDeps: false },
  });
  const specAccess =
    specs.length === 0 || (await inspect(specs, { ...configuration, forbidden: specRules }));
  const publicTypes = await inspectPublicDeclarations();
  process.exitCode =
    unowned.length === 0 && architecture && runtime && specAccess && publicTypes ? 0 : 1;
}

/**
 * Cruises the declarations a caller of the public entry compiles against, which name every
 * module a public type depends on, whether the source imported it as a type or a value.
 */
async function inspectPublicDeclarations() {
  if (!existsSync(publicApplicationSource)) return true;
  const directory = await Result.tryPromise(() => mkdtemp(join(tmpdir(), 'jig-declarations-')));
  if (directory.isErr()) {
    console.error(`Cannot emit public declarations: ${directory.error.cause}`);
    return false;
  }
  emitDeclarations(publicApplicationSource, directory.value);
  const passed = await inspect(
    [publicApplicationSource.replace(/[.]ts$/, '.d.ts')],
    { ...configuration, forbidden: publicDeclarationRules },
    directory.value,
  );
  const removed = await Result.tryPromise(() =>
    rm(directory.value, { recursive: true, force: true }),
  );
  if (removed.isErr()) console.error(`Cannot remove ${directory.value}: ${removed.error.cause}`);
  return passed;
}

function emitDeclarations(entry, outDir) {
  const { config } = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config ?? {}, ts.sys, '.');
  const program = ts.createProgram([entry], {
    ...options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    incremental: false,
    composite: false,
    rootDir: '.',
    outDir,
  });
  program.emit();
}

async function inspect(files, rules, baseDir = process.cwd()) {
  const result = await Result.tryPromise(() =>
    cruise(files, { ...rules.options, baseDir, ruleSet: rules, validate: true }),
  );
  if (result.isErr()) {
    console.error(
      result.error.cause instanceof Error ? result.error.cause.message : result.error.cause,
    );
    return false;
  }
  const graph = result.value.output;
  if (typeof graph === 'string') panic('Expected dependency-cruiser object output');
  const report = await format(graph, { outputType: 'err-long' });
  console.log(report.output);
  for (const violation of graph.summary.violations.filter(({ type }) => type === 'cycle')) {
    const path = [violation.from, ...(violation.cycle ?? []).map(({ name }) => name)];
    console.error(`${violation.rule.name}: ${path.join(' -> ')}`);
    for (const source of graph.modules) {
      for (const dependency of source.dependencies) {
        const index = path.indexOf(owner(source.source));
        if (index >= 0 && path[index + 1] === owner(dependency.resolved)) {
          console.error(`  ${source.source} -> ${dependency.resolved} (${dependency.module})`);
        }
      }
    }
  }
  return graph.summary.error === 0;
}

function owner(source) {
  return source.split('/').slice(0, 2).join('/');
}
