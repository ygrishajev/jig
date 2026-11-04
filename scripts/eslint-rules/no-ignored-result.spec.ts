import { RuleTester } from '@typescript-eslint/rule-tester';
import * as vitest from 'vitest';

import { noIgnoredResult } from './no-ignored-result.js';

RuleTester.afterAll = vitest.afterAll;
RuleTester.describe = vitest.describe;
RuleTester.it = vitest.it;
RuleTester.itOnly = vitest.it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: { allowDefaultProject: ['*.ts'] },
      tsconfigRootDir: new URL('../..', import.meta.url).pathname,
    },
  },
});

const declarations = `
  import { Result } from 'better-result';
  declare function parse(x: string): Result<number, Error>;
  declare function load(x: string): Promise<Result<number, Error>>;
  declare function save(): Promise<void>;
  declare function f(n: number): void;
  declare function g(e: Error): void;
  declare const x: string;
  declare function each(callback: (n: number) => void): void;
  declare function mapEach<T>(callback: (n: number) => T): T[];
`;

ruleTester.run('no-ignored-result', noIgnoredResult, {
  valid: [
    { code: `${declarations} export function a() { return parse(x); }` },
    { code: `${declarations} export const r = parse(x);` },
    { code: `${declarations} parse(x).match({ ok: f, err: g });` },
    { code: `${declarations} export async function a() { await save(); }` },
    { code: `${declarations} let kept: Result<number, Error>; kept = parse(x); export { kept };` },
    { code: `${declarations} void save();` },
    { code: `${declarations} export const all = mapEach(() => parse(x));` },
    { code: `${declarations} each((n) => f(n));` },
    {
      code: `${declarations} each(() => { const kept = parse(x); kept.match({ ok: f, err: g }); });`,
    },
  ],
  invalid: [
    { code: `${declarations} parse(x);`, errors: [{ messageId: 'ignored' }] },
    { code: `${declarations} load(x);`, errors: [{ messageId: 'ignored' }] },
    { code: `${declarations} Result.ok(1);`, errors: [{ messageId: 'ignored' }] },
    { code: `${declarations} Result.err(new Error());`, errors: [{ messageId: 'ignored' }] },
    {
      code: `${declarations} export async function a() { await load(x); }`,
      errors: [{ messageId: 'ignored' }],
    },
    { code: `${declarations} void parse(x);`, errors: [{ messageId: 'ignored' }] },
    { code: `${declarations} void load(x);`, errors: [{ messageId: 'ignored' }] },
    { code: `${declarations} each(() => parse(x));`, errors: [{ messageId: 'ignored' }] },
    { code: `${declarations} each(async () => load(x));`, errors: [{ messageId: 'ignored' }] },
  ],
});
