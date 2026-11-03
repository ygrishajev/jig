import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { callOrderViolations, declarationsInCallOrder } from './declarations-in-call-order.js';

describe('callOrderViolations', () => {
  it('accepts an entry point followed by its callees, depth first', () => {
    const source = `
      export function entry() { first(); second(); }
      function first() { helperOfFirst(); }
      function helperOfFirst() {}
      function second() {}
    `;

    expect(callOrderViolations(source)).toEqual([]);
  });

  it('reports a helper declared above its caller, naming what belongs there', () => {
    const source = `
      function helper() {}
      export function entry() { helper(); }
    `;

    expect(callOrderViolations(source)).toMatchObject([
      { found: 'helper', expected: 'entry', order: ['entry', 'helper'] },
    ]);
  });

  it('places a shared callee once, after its first caller', () => {
    const source = `
      export function entry() { a(); b(); }
      function a() { shared(); }
      function shared() {}
      function b() { shared(); }
    `;

    expect(callOrderViolations(source)).toEqual([]);
  });

  it('lets a constant that is only read inside a function sit below it', () => {
    const source = `
      export function check(text: string) { return schema.parse(text); }
      const schema = z.string();
    `;

    expect(callOrderViolations(source)).toEqual([]);
  });

  it('keeps a constant read while the module loads above what reads it', () => {
    const readFirst = `
      const stepSchema = z.object({});
      export const configSchema = z.object({ ...byRole(() => stepSchema) });
    `;
    const readLater = `
      export const configSchema = z.object({ ...byRole(() => stepSchema) });
      const stepSchema = z.object({});
    `;

    expect(callOrderViolations(readFirst)).toEqual([]);
    expect(callOrderViolations(readLater)).toMatchObject([
      { found: 'configSchema', expected: 'stepSchema' },
    ]);
  });

  it('puts types first, and a type taken from a value right after that value', () => {
    const ordered = `
      export interface Input { id: string }
      export function parse(input: Input): Parsed { return schema.parse(input); }
      const schema = z.object({ id: z.string() });
      export type Parsed = z.infer<typeof schema>;
    `;
    const typeBetweenFunctions = `
      export function parse(input: Input) { return input; }
      export interface Input { id: string }
    `;

    expect(callOrderViolations(ordered)).toEqual([]);
    expect(callOrderViolations(typeBetweenFunctions)).toMatchObject([
      { found: 'parse', expected: 'Input' },
    ]);
  });

  it('keeps statements that run at load below everything', () => {
    const source = `
      if (isMain) main();
      function main() {}
    `;

    expect(callOrderViolations(source)).toMatchObject([{ found: 'statement', expected: 'main' }]);
  });

  it('wants a private method after the first method that calls it', () => {
    const source = `
      class Engine {
        private settle() {}
        run() { this.settle(); }
      }
    `;

    expect(callOrderViolations(source)).toMatchObject([
      { found: 'settle', expected: 'run', order: ['run', 'settle'] },
    ]);
  });
});

describe('declarationsInCallOrder', () => {
  it('reports through ESLint at the misplaced declaration', () => {
    const source = 'function helper() {}\n\nexport function entry() {\n  helper();\n}\n';

    const messages = new Linter({ configType: 'flat' }).verify(
      source,
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { jig: { rules: { 'declarations-in-call-order': declarationsInCallOrder } } },
        rules: { 'jig/declarations-in-call-order': 'error' },
      },
      'module.ts',
    );

    expect(messages).toMatchObject([
      { ruleId: 'jig/declarations-in-call-order', messageId: 'outOfOrder', line: 1 },
    ]);
  });
});
