import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

import { declarationsInCallOrder } from './scripts/eslint-rules/declarations-in-call-order.ts';
import { noIgnoredResult } from './scripts/eslint-rules/no-ignored-result.ts';

/** `.claude/instructions/use-mock-instead-of-as-unknown-as-in-tests.md` */
const noDoubleCast = {
  selector: 'TSAsExpression > TSAsExpression[typeAnnotation.type="TSUnknownKeyword"]',
  message: 'Build the double with mock<T>(), not `as unknown as T`.',
};

/** `.claude/instructions/errors-as-values.md` */
const noThrow = {
  selector: 'ThrowStatement',
  message: 'jig does not throw: return an Err, or panic() for a bug.',
};

/** `.claude/instructions/testing-conventions.md` and the `setup` instruction. */
const specRules = [
  {
    selector: 'CallExpression[callee.object.name="vi"][callee.property.name=/^(mock|doMock)$/]',
    message: 'Never mock a module: pass a stand-in for the port instead.',
  },
  {
    selector: 'CallExpression[callee.name=/^(beforeEach|afterEach)$/]',
    message: 'Use a setup function at the bottom of the root describe, not a hook.',
  },
];

/** `.claude/instructions/parse-input-at-the-edge.md` */
const noCommanderParsing = {
  selector: 'CallExpression[callee.property.name=/^(argParser|choices)$/]',
  message: "Parse a command's input with its zod schema, not commander's argParser or choices.",
};

/** awilix wires the app in `src/app/`; everything else receives what it needs. */
const awilixOnlyInApp = {
  name: 'awilix',
  allowTypeImports: true,
  message: 'awilix is used only in src/app/.',
};

/** `.claude/instructions/testing-conventions.md`: every external call lives in an adapter. */
const externalCallsInAdapters = [
  'fs',
  'fs/promises',
  'node:fs',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'execa',
  'simple-git',
  '@ai-hero/sandcastle',
].map((name) => ({
  name,
  allowTypeImports: true,
  message: 'Domain, flow and step code reaches the outside through a port; put this in an adapter.',
}));

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.jig/**',
      'coverage/**',
      'reports/**',
      '.stryker-tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^\\u0000'],
            ['^react', '^(?!(@src|@test))@?\\w'],
            [
              '^@src',
              '^\\.\\.(?!/?$)',
              '^\\.\\./?$',
              '^\\./(?=.*/)(?!/?$)',
              '^\\.(?!/?$)',
              '^\\./?$',
            ],
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': ['error', noDoubleCast],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: { 'no-restricted-syntax': ['error', noDoubleCast, ...specRules] },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: { 'no-restricted-syntax': ['error', noDoubleCast, noThrow] },
  },
  {
    files: ['src/cli/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: { 'no-restricted-syntax': ['error', noDoubleCast, noThrow, noCommanderParsing] },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/app/**', 'src/**/*.spec.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': ['error', { paths: [awilixOnlyInApp] }] },
  },
  {
    files: ['src/domain/**/*.ts', 'src/flow/**/*.ts', 'src/steps/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [awilixOnlyInApp, ...externalCallsInAdapters],
          patterns: [
            {
              group: ['@ai-hero/sandcastle/*'],
              allowTypeImports: true,
              message: 'Domain, flow and step code reaches the outside through a port.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    plugins: {
      sonarjs,
      jig: {
        rules: {
          'declarations-in-call-order': declarationsInCallOrder,
          'no-ignored-result': noIgnoredResult,
        },
      },
    },
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      'jig/no-ignored-result': 'error',
      complexity: ['error', { max: 10 }],
      'sonarjs/cognitive-complexity': ['error', 15],
      'jig/declarations-in-call-order': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
    },
  },
);
