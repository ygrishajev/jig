import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { type ChangedFile, type ChangeKind, protectedChanges } from './protected-paths.js';

describe('protectedChanges', () => {
  it('leaves a test file the slice added alone', () => {
    const { change, inNested, inSubdirectory, sourceFile, sourceExtension } = setup();

    const added = [
      change('added', inNested(`${faker.lorem.slug()}.spec.${sourceExtension()}`)),
      change('added', inNested(`${faker.lorem.slug()}.test.${sourceExtension()}`)),
      change('added', inSubdirectory('test', sourceFile())),
      change('added', inSubdirectory('__snapshots__', `${faker.lorem.slug()}.snap`)),
    ];

    expect(protectedChanges(added)).toEqual([]);
  });

  it('flags test files it modified, deleted or renamed, whatever test pattern they match', () => {
    const { change, inNested, inSubdirectory, sourceFile, sourceExtension } = setup();
    const matching = [
      inNested(`${faker.lorem.slug()}.spec.${sourceExtension()}`),
      inNested(`${faker.lorem.slug()}.test.${sourceExtension()}`),
      inSubdirectory('test', sourceFile()),
      inSubdirectory('tests', sourceFile()),
      inSubdirectory('__tests__', sourceFile()),
      inNested(`${faker.lorem.slug()}.snap`),
      inSubdirectory('__snapshots__', `${faker.lorem.slug()}.snap`),
    ];
    const touched: ChangeKind[] = ['modified', 'deleted', 'renamed'];
    const changes = touched.flatMap((kind) => matching.map((path) => change(kind, path)));

    expect(protectedChanges(changes)).toEqual(changes);
  });

  it('flags every check-configuration file, also when the slice added it', () => {
    const { change, configPaths } = setup();
    const added = configPaths().map((path) => change('added', path));

    expect(protectedChanges(added)).toEqual(added);
  });

  it('never flags an ordinary source file', () => {
    const { change, inNested, sourceFile } = setup();
    const kinds: ChangeKind[] = ['added', 'modified', 'deleted', 'renamed'];
    const changes = kinds.map((kind) => change(kind, inNested(sourceFile())));

    expect(protectedChanges(changes)).toEqual([]);
  });

  function setup() {
    const directory = faker.lorem.slug();
    const nested = faker.lorem.slug();
    const sourceExtension = () => faker.helpers.arrayElement(['ts', 'tsx', 'js', 'jsx']);
    const sourceFile = () => `${faker.lorem.slug()}.${sourceExtension()}`;
    const inNested = (file: string) => `${directory}/${nested}/${file}`;
    const inSubdirectory = (name: string, file: string) => `${directory}/${nested}/${name}/${file}`;
    const change = (kind: ChangeKind, path: string): ChangedFile => ({ path, kind });
    const configPaths = () => [
      inNested('package.json'),
      inNested(`eslint.config.${faker.helpers.arrayElement(['js', 'mjs', 'cjs', 'ts'])}`),
      inNested(`.prettierrc${faker.helpers.arrayElement(['', '.json', '.yaml', '.toml', '.cjs'])}`),
      inNested(`tsconfig${faker.helpers.arrayElement(['', '.build', '.app'])}.json`),
      inNested(`biome.json${faker.helpers.arrayElement(['', 'c'])}`),
      inNested(`vitest.${faker.helpers.arrayElement(['config.ts', 'workspace.ts', 'config.mjs'])}`),
      inNested(`jest.config.${sourceExtension()}`),
      inNested(`stryker.conf.${faker.helpers.arrayElement(['json', 'js', 'cjs'])}`),
      `.github/workflows/${faker.lorem.slug()}.yml`,
      `.husky/${faker.lorem.slug()}`,
    ];
    return { change, configPaths, inNested, inSubdirectory, sourceFile, sourceExtension };
  }
});
