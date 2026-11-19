import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

import { declarationsInCallOrder } from './scripts/eslint-rules/declarations-in-call-order.ts';
import { noIgnoredResult } from './scripts/eslint-rules/no-ignored-result.ts';

/** `.claude/rules/testing-conventions.md`: `mock<T>()`, not `as unknown as T`. */
const noDoubleCast = {
  selector: 'TSAsExpression > TSAsExpression[typeAnnotation.type="TSUnknownKeyword"]',
  message: 'Build the double with mock<T>(), not `as unknown as T`.',
};

/** `.claude/rules/errors-as-values.md` */
const noThrow = {
  selector: 'ThrowStatement',
  message: 'jig does not throw: return an Err, or panic() for a bug.',
};

/** `.claude/rules/testing-conventions.md` */
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

/**
 * `.claude/rules/errors-as-values.md`: a spec may throw what a fake's real counterpart throws, but
 * a guard on the test's own assumptions — an Error with a fixed message — is a panic.
 */
const noGuardThrowInSpecs = {
  selector:
    'ThrowStatement[argument.type="NewExpression"][argument.callee.name="Error"][argument.arguments.0.type=/^(Literal|TemplateLiteral)$/]',
  message: 'A guard in a spec is a bug in the test: panic() instead of throwing an Error.',
};

/** `.claude/rules/parse-input-at-the-edge.md` */
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

/** `.claude/rules/testing-conventions.md`: every external call lives in an adapter. */
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

const githubOnlyInIntegration = {
  group: ['**/integrations/github/**'],
  message: 'The GitHub integration depends on core modules; core modules must never import it.',
};

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
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable' } },
  },
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
    rules: { 'no-restricted-syntax': ['error', noDoubleCast, noGuardThrowInSpecs, ...specRules] },
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
    ignores: ['src/integrations/github/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [githubOnlyInIntegration] },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/app/**', 'src/**/*.spec.ts', 'src/integrations/github/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths: [awilixOnlyInApp], patterns: [githubOnlyInIntegration] },
      ],
    },
  },
  {
    files: ['src/integrations/github/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
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
            githubOnlyInIntegration,
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
