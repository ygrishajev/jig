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

/** `.claude/rules/testing-conventions.md`: a unit spec starts no process. */
const startsProcesses = ['simple-git', 'execa', 'child_process', 'node:child_process'].map(
  (name) => ({
    name,
    allowTypeImports: true,
    message: 'A spec that starts a process is an integration spec: name it *.integration.spec.ts.',
  }),
);

/** `.claude/rules/testing-conventions.md`: code that only decides is tested on fakes of its ports. */
const noIntegrationSpec = {
  selector: 'Program',
  message:
    'This layer reaches git and processes only through ports: test it in a unit spec on fakes.',
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
    rules: { 'no-restricted-syntax': ['error', noDoubleCast, noGuardThrowInSpecs, ...specRules] },
  },
  {
    files: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    ignores: ['**/*.integration.spec.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: startsProcesses,
          patterns: [
            {
              regex: 'tests/support/(temp-repo|run-worktree|open-run-worktree|commit-all)[.]js$',
              allowTypeImports: true,
              message:
                'A spec on a real repository is an integration spec: name it *.integration.spec.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/{config,domain,flow,prompts,steps}/**/*.integration.spec.ts'],
    rules: { 'no-restricted-syntax': ['error', noIntegrationSpec] },
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
    files: ['src/domain/**/*.ts', 'src/flow/**/*.ts', 'src/steps/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: externalCallsInAdapters,
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
