import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
const integrationRoot = resolve(sourceRoot, 'integrations/github');

describe('GitHub integration boundary', () => {
  it('keeps every source outside the integration independent of it', async () => {
    const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((file) => !isInsideIntegration(file));
    const sources = await Promise.all(
      files.map(async (file) => ({ file, source: await readFile(file, 'utf8') })),
    );
    const offenders = sources
      .filter(({ file, source }) => importsIntegration(file, source))
      .map(({ file }) => relative(sourceRoot, file));

    expect(offenders, `Files importing the GitHub integration: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it.each([
    ['cli/main.ts', "import { command } from '../integrations/github/command.js';"],
    ['app/container.ts', "import type { GitHub } from '../integrations/github/github-port.js';"],
    ['domain/index.ts', "export { command } from '../integrations/github/command.js';"],
    ['flow/index.ts', "export * from '../integrations/github/command.js';"],
    ['steps/run.ts', "const command = import('../integrations/github/command.js');"],
    ['cli/main.spec.ts', "import '../integrations/github/command.js';"],
    ['cli/nested/main.ts', "import '../../integrations/github/../github/command.js';"],
  ])('flags an integration dependency from %s', (file, source) => {
    expect(importsIntegration(resolve(sourceRoot, file), source)).toBe(true);
  });

  it.each([
    "import { buildCli } from './main.js';",
    "import { GitHub } from 'github';",
    'const example = "import \'../integrations/github/command.js\'";',
    "import '../integrations/github-other/command.js';",
  ])('accepts a source without an integration dependency: %s', (source) => {
    expect(importsIntegration(resolve(sourceRoot, 'cli/main.ts'), source)).toBe(false);
  });
});

function importsIntegration(file: string, source: string) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const collectSpecifiers = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, collectSpecifiers);
  };
  collectSpecifiers(parsed);
  return specifiers.some(
    (specifier) =>
      specifier.startsWith('.') && isInsideIntegration(resolve(dirname(file), specifier)),
  );
}

function isInsideIntegration(file: string) {
  return file === integrationRoot || file.startsWith(`${integrationRoot}${sep}`);
}
