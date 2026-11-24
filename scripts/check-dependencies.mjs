import { panic, Result } from 'better-result';
import { allExtensions, cruise, format } from 'dependency-cruiser';
import console from 'node:console';
import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import process from 'node:process';

import configuration, {
  ownedProductionPath,
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
  process.exitCode = unowned.length === 0 && architecture && runtime && specAccess ? 0 : 1;
}

async function inspect(files, rules) {
  const result = await Result.tryPromise(() =>
    cruise(files, { ...rules.options, ruleSet: rules, validate: true }),
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
