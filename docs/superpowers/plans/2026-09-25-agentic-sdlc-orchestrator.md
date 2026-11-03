# Agentic SDLC Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v1 CLI orchestrator that turns a markdown request into reviewed, merge-ready commits via a reconciler-driven pipeline (prepare → implement → review → merge), wrapping an agentic coding CLI as a pluggable provider.

**Architecture:** A reconciler core reads persisted run state (context, plan, ordered slices) plus real git state, decides the next actionable step for the current slice, and executes it through swappable strategies (input source, agent provider, merge mode). State is plain gitignored JSON on local disk (`.jig/<runId>/state/`); slice implementation happens in a dedicated git worktree, one branch at a time (v1 is sequential — no parallel slices, no conflict preflight/auto-resolve — see Global Constraints).

**Tech Stack:** TypeScript (strict, ESM, Node >=20), commander (CLI), simple-git (git operations), zod (state/config validation), execa (subprocess spawning for the real agent provider), Vitest (tests), ESLint + Prettier, StrykerJS (mutation testing), secretlint.

**Spec:** `docs/superpowers/specs/2026-09-25-agentic-sdlc-orchestrator-design.md`

## Global Constraints

- Node >=20, TypeScript strict mode, ESM (`"type": "module"`), npm as package manager.
- ESLint and Prettier must both be clean; this is an acceptance bar, not advisory.
- No `gh` dependency anywhere in v1. No `gh-issue.ts` / `gh.ts` stub files — the strategy interfaces are designed so adding them later doesn't require touching existing code, but v1 does not ship placeholder files for unimplemented strategies.
- `jig.config.json` only in v1 (no `.ts`/`.js` config loading — avoids needing a runtime TS loader for config alone).
- **State is plain local JSON, not git-backed.** An earlier version of this plan stored run state on a dedicated git branch checked out in its own worktree, for cross-machine durability. That was cut: it was the buggiest mechanism in review (an untracked nested worktree registers as a dirty embedded repo in the primary checkout, breaking every "is the working tree clean" check used by merge), and its payoff only matters for a future multi-machine "software factory," not a working v1. State now lives at `.jig/<runId>/state/*.json`, plain files, gitignored. Crash recovery still works (`resume` reads it back off local disk); only "survives a wiped local disk" is lost, which nothing else in v1 promised either.
- `.jig/` (all run state and workspace worktrees) and `.jig-step-output.json` (the agent-provider structured-output convention, written into whatever `cwd` a provider runs in) must both be listed in the repo's `.gitignore` — added in Task 1. Neither may ever be picked up by `commitAll`.
- **No conflict preflight and no `resolve-conflicts` step in v1.** An earlier version of this plan checked every slice for merge conflicts before acting and auto-resolved them via the agent, capped and retried. That was cut: in a sequential (non-parallel) pipeline, conflicts are rare — they only come from your own unrelated commits to main or time passing under manual-merge mode — and it was the second-buggiest area in review (ignored failure results, assumed worktree state that may not exist after a restart). `mergeBranchInto` (Task 4) throws a plain git error on a real conflict; you resolve it by hand in the workspace worktree and re-run `jig merge`, exactly like an ordinary local `git merge` conflict.
- **Known v1 limitation: a manually squash-merged slice is not reliably detected as merged.** "Is this slice done" is decided by checking whether the slice branch's commits are reachable from the base branch (`isBranchMergedInto`, Task 4). A regular merge or fast-forward is detected correctly; a squash-merge is not, because it produces a new commit rather than replaying the original ones. This mostly matters for a future `gh` integration (GitHub's default PR-merge button squashes); v1 has no `gh` dependency, so it's not the primary manual-merge path today, but the limitation is real and undocumented nowhere else — this is that documentation.
- Slice implementation happens in a dedicated worktree at `.jig/<runId>/workspace/`, created lazily on first use (not during `prepare`), reused across all of a run's slices by checking out a new branch per slice.
- Naming: every exported name must be understandable without opening its definition — no `utils`/`helpers`/`manager`/`data` dumping-ground names.
- File/module boundaries: one responsibility per file; split rather than grow a file that's taking on a second concern.
- Declaration order within a file: usage before declaration, ordered by first use — not alphabetical.
- No placeholder code (`TODO`, `// implement later`, empty stub functions) anywhere in this plan's deliverables.
- **No raw provider transcript logging (`logs/<sliceId>-<step>-<n>.log`) in v1.** The spec's data model names this; it was never built, and the final whole-branch review caught the gap going undocumented rather than the feature going missing being a defect. Cut for v1: when a run goes `stuck`, there is currently no persisted record of what the agent actually did or said beyond the terse `lastFeedback` string. Worth revisiting if `stuck` runs turn out to need more forensics than that in practice.
- **No `--slice <id>` targeting in v1.** The spec's CLI reference lists it on `implement`/`review`/`merge`/`create-pr`; the plan silently dropped it since v1 is strictly sequential (exactly one slice can ever be actionable at a time, so there's nothing to disambiguate). Revisit if/when the parked parallel-slice work (see Extensibility/Roadmap in the spec) returns.

---

### Task 1: Project scaffolding and tooling

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `vitest.config.ts`
- Create: `stryker.conf.json`
- Create: `.secretlintrc.json`
- Create: `src/cli/main.ts`
- Test: `tests/cli/main.test.ts`
- Modify: `index.js` (delete — superseded by `src/cli/main.ts`)
- Modify: `.gitignore` (add `.jig/` and the structured-output filename)

**Interfaces:**

- Produces: `jig` CLI binary entry point at `src/cli/main.ts` (extended by later tasks); npm scripts `build`, `lint`, `format`, `format:check`, `test`, `test:mutation`, `secretlint`, `dev`.

- [ ] **Step 1: Remove the placeholder scaffold and gitignore run state/scratch output**

```bash
git rm index.js
```

Append to `.gitignore` (it already has `.idea/` and `node_modules/` from an earlier commit):

```
.jig/
.jig-step-output.json
```

This matters from the very first task: without it, every run's local state and
worktrees register as untracked/embedded content in the primary checkout,
which breaks the "is the working tree clean" check every merge relies on
(Task 4) — a bug that only shows up once Task 14 tries to merge, much harder
to diagnose after the fact than to prevent now.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "jig",
  "version": "0.1.0",
  "description": "Agentic SDLC pipeline orchestrator",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "jig": "./dist/cli/main.js" },
  "main": "./dist/cli/main.js",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli/main.ts",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:mutation": "stryker run",
    "secretlint": "secretlint '**/*'"
  },
  "dependencies": {
    "commander": "^13.0.0",
    "execa": "^9.5.0",
    "simple-git": "^3.27.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@secretlint/secretlint-rule-preset-recommend": "^9.0.0",
    "@stryker-mutator/core": "^8.7.0",
    "@stryker-mutator/vitest-runner": "^8.7.0",
    "@types/node": "^22.10.0",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "prettier": "^3.4.0",
    "secretlint": "^9.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.19.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: lockfile generated, no errors.

- [ ] **Step 4: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Write `eslint.config.js`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, prettier, {
  ignores: ['dist/**', 'node_modules/**', '.jig/**'],
});
```

- [ ] **Step 6: Write `.prettierrc.json` and `.prettierignore`**

`.prettierrc.json`:

```json
{
  "singleQuote": true,
  "semi": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

`.prettierignore`:

```
dist/
node_modules/
.jig/
```

- [ ] **Step 7: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 8: Write `stryker.conf.json`**

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "packageManager": "npm",
  "testRunner": "vitest",
  "mutate": ["src/**/*.ts", "!src/cli/main.ts"],
  "reporters": ["html", "clear-text", "progress"],
  "coverageAnalysis": "perTest"
}
```

- [ ] **Step 9: Write `.secretlintrc.json`**

```json
{
  "rules": [{ "id": "@secretlint/secretlint-rule-preset-recommend" }]
}
```

- [ ] **Step 10: Write the failing test for the CLI entry point**

```ts
// tests/cli/main.test.ts
import { describe, expect, it } from 'vitest';
import { buildCli } from '../../src/cli/main.js';

describe('buildCli', () => {
  it('exposes the jig program name', () => {
    const program = buildCli();
    expect(program.name()).toBe('jig');
  });
});
```

- [ ] **Step 11: Run the test to verify it fails**

Run: `npx vitest run tests/cli/main.test.ts`
Expected: FAIL — `src/cli/main.ts` does not exist yet.

- [ ] **Step 12: Write the minimal CLI entry point**

```ts
// src/cli/main.ts
#!/usr/bin/env node
import { Command } from 'commander';

export function buildCli(): Command {
  const program = new Command();
  program.name('jig').description('Agentic SDLC pipeline orchestrator').version('0.1.0');
  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildCli().parse(process.argv);
}
```

- [ ] **Step 13: Run the test to verify it passes**

Run: `npx vitest run tests/cli/main.test.ts`
Expected: PASS

- [ ] **Step 14: Verify lint, format, and build all pass**

Run: `npm run lint && npm run format:check && npm run build`
Expected: all exit 0. If Prettier reports unformatted files, run `npm run format` once and re-check.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript CLI project with lint/format/test/mutation/secret tooling"
```

---

### Task 2: Git layer — repository and branch helpers

**Files:**

- Create: `src/git/repository.ts`
- Create: `src/git/branch.ts`
- Test: `tests/git/repository.test.ts`
- Test: `tests/git/branch.test.ts`
- Create: `tests/support/temp-repo.ts` (shared test fixture)

**Interfaces:**

- Produces: `openRepo(cwd): SimpleGit`, `isWorkingTreeClean(cwd): Promise<boolean>`, `commitAll(cwd, message): Promise<string | null>` from `repository.ts`; `getCurrentBranch(cwd): Promise<string>`, `localBranchExists(cwd, branchName): Promise<boolean>`, `createBranchFrom(cwd, branchName, fromRef): Promise<void>`, `checkoutExistingBranch(cwd, branchName): Promise<void>`, `checkoutNewBranchAt(cwd, branchName, startPoint): Promise<void>` from `branch.ts`.
- Consumes: nothing (foundation layer).

- [ ] **Step 1: Write the shared temp-repo test fixture**

```ts
// tests/support/temp-repo.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export interface TempRepo {
  dir: string;
  cleanup: () => Promise<void>;
}

export async function createTempRepo(): Promise<TempRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jig-test-'));
  const git = simpleGit({ baseDir: dir });
  await git.init(['--initial-branch=main']);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await writeFile(path.join(dir, 'README.md'), '# test repo\n');
  await git.add('README.md');
  await git.commit('initial commit');
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Write the failing test for repository helpers**

```ts
// tests/git/repository.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commitAll, isWorkingTreeClean } from '../../src/git/repository.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('isWorkingTreeClean', () => {
  it('is true right after a commit', async () => {
    repo = await createTempRepo();
    expect(await isWorkingTreeClean(repo.dir)).toBe(true);
  });

  it('is false with an untracked file', async () => {
    repo = await createTempRepo();
    await writeFile(path.join(repo.dir, 'new.txt'), 'hi');
    expect(await isWorkingTreeClean(repo.dir)).toBe(false);
  });
});

describe('commitAll', () => {
  it('commits pending changes and returns the sha', async () => {
    repo = await createTempRepo();
    await writeFile(path.join(repo.dir, 'new.txt'), 'hi');
    const sha = await commitAll(repo.dir, 'add new.txt');
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await isWorkingTreeClean(repo.dir)).toBe(true);
  });

  it('returns null when there is nothing to commit', async () => {
    repo = await createTempRepo();
    expect(await commitAll(repo.dir, 'noop')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/git/repository.test.ts`
Expected: FAIL — `src/git/repository.ts` does not exist.

- [ ] **Step 4: Write `src/git/repository.ts`**

```ts
import { simpleGit, type SimpleGit } from 'simple-git';

export function openRepo(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const status = await openRepo(cwd).status();
  return status.isClean();
}

export async function commitAll(cwd: string, message: string): Promise<string | null> {
  const git = openRepo(cwd);
  if (await isWorkingTreeClean(cwd)) return null;
  await git.add('-A');
  const result = await git.commit(message);
  return result.commit;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/git/repository.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing test for branch helpers**

```ts
// tests/git/branch.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutExistingBranch,
  checkoutNewBranchAt,
  createBranchFrom,
  getCurrentBranch,
  localBranchExists,
} from '../../src/git/branch.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('branch helpers', () => {
  it('reports the current branch', async () => {
    repo = await createTempRepo();
    expect(await getCurrentBranch(repo.dir)).toBe('main');
  });

  it('creates a branch from a ref without checking it out', async () => {
    repo = await createTempRepo();
    await createBranchFrom(repo.dir, 'feature/x', 'main');
    expect(await localBranchExists(repo.dir, 'feature/x')).toBe(true);
    expect(await getCurrentBranch(repo.dir)).toBe('main');
  });

  it('checks out a new branch at a start point', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/y', 'main');
    expect(await getCurrentBranch(repo.dir)).toBe('feature/y');
  });

  it('checks out an existing branch', async () => {
    repo = await createTempRepo();
    await createBranchFrom(repo.dir, 'feature/z', 'main');
    await checkoutExistingBranch(repo.dir, 'feature/z');
    expect(await getCurrentBranch(repo.dir)).toBe('feature/z');
  });

  it('reports false for a branch that does not exist', async () => {
    repo = await createTempRepo();
    expect(await localBranchExists(repo.dir, 'nope')).toBe(false);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/git/branch.test.ts`
Expected: FAIL — `src/git/branch.ts` does not exist.

- [ ] **Step 8: Write `src/git/branch.ts`**

```ts
import { openRepo } from './repository.js';

export async function getCurrentBranch(cwd: string): Promise<string> {
  const status = await openRepo(cwd).status();
  if (!status.current) throw new Error(`Cannot determine current branch in ${cwd}`);
  return status.current;
}

export async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  const summary = await openRepo(cwd).branchLocal();
  return Object.hasOwn(summary.branches, branchName);
}

export async function createBranchFrom(
  cwd: string,
  branchName: string,
  fromRef: string,
): Promise<void> {
  await openRepo(cwd).branch([branchName, fromRef]);
}

export async function checkoutExistingBranch(cwd: string, branchName: string): Promise<void> {
  await openRepo(cwd).checkout(branchName);
}

export async function checkoutNewBranchAt(
  cwd: string,
  branchName: string,
  startPoint: string,
): Promise<void> {
  await openRepo(cwd).checkoutBranch(branchName, startPoint);
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/git/repository.test.ts tests/git/branch.test.ts`
Expected: PASS

- [ ] **Step 10: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add git repository and branch helpers"
```

---

### Task 3: Git layer — worktree helpers

**Files:**

- Create: `src/git/worktree.ts`
- Test: `tests/git/worktree.test.ts`

**Interfaces:**

- Consumes: `openRepo` from `src/git/repository.ts` (Task 2).
- Produces: `addWorktreeForNewBranch(repoRoot, worktreePath, branchName, fromRef): Promise<void>`, `addWorktreeForExistingBranch(repoRoot, worktreePath, branchName): Promise<void>`, `removeWorktree(repoRoot, worktreePath): Promise<void>`, `worktreeExists(repoRoot, worktreePath): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/git/worktree.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  addWorktreeForExistingBranch,
  addWorktreeForNewBranch,
  removeWorktree,
  worktreeExists,
} from '../../src/git/worktree.js';
import { createBranchFrom } from '../../src/git/branch.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('worktree helpers', () => {
  it('adds a worktree for a new branch', async () => {
    repo = await createTempRepo();
    const wt = path.join(repo.dir, '.wt', 'a');
    await addWorktreeForNewBranch(repo.dir, wt, 'feature/a', 'main');
    expect(existsSync(wt)).toBe(true);
    expect(await worktreeExists(repo.dir, wt)).toBe(true);
  });

  it('adds a worktree for an existing branch', async () => {
    repo = await createTempRepo();
    await createBranchFrom(repo.dir, 'feature/b', 'main');
    const wt = path.join(repo.dir, '.wt', 'b');
    await addWorktreeForExistingBranch(repo.dir, wt, 'feature/b');
    expect(existsSync(wt)).toBe(true);
  });

  it('removes a worktree', async () => {
    repo = await createTempRepo();
    const wt = path.join(repo.dir, '.wt', 'c');
    await addWorktreeForNewBranch(repo.dir, wt, 'feature/c', 'main');
    await removeWorktree(repo.dir, wt);
    expect(existsSync(wt)).toBe(false);
    expect(await worktreeExists(repo.dir, wt)).toBe(false);
  });

  it('reports false for a path with no worktree', async () => {
    repo = await createTempRepo();
    expect(await worktreeExists(repo.dir, path.join(repo.dir, '.wt', 'nope'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/git/worktree.test.ts`
Expected: FAIL — `src/git/worktree.ts` does not exist.

- [ ] **Step 3: Write `src/git/worktree.ts`**

```ts
import { openRepo } from './repository.js';

export async function addWorktreeForNewBranch(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
  fromRef: string,
): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'add', '-b', branchName, worktreePath, fromRef]);
}

export async function addWorktreeForExistingBranch(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'add', worktreePath, branchName]);
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await openRepo(repoRoot).raw(['worktree', 'remove', worktreePath, '--force']);
}

export async function worktreeExists(repoRoot: string, worktreePath: string): Promise<boolean> {
  const list = await openRepo(repoRoot).raw(['worktree', 'list', '--porcelain']);
  return list.split('\n').some((line) => line === `worktree ${worktreePath}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/git/worktree.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add git worktree helpers"
```

---

### Task 4: Git layer — merge and merged-detection

v1 has no conflict preflight and no `resolve-conflicts` step (dropped — see
Global Constraints). If a merge genuinely conflicts, `mergeBranchInto` below
throws a plain git error; the CLI surfaces it and you resolve it by hand in
the workspace worktree, same as any local `git merge` conflict.

**Files:**

- Create: `src/git/merge.ts`
- Test: `tests/git/merge.test.ts`

**Interfaces:**

- Consumes: `openRepo`, `isWorkingTreeClean` (repository.ts, Task 2); `getCurrentBranch` (branch.ts, Task 2).
- Produces: `isBranchMergedInto(repoRoot, branchName, intoBranch): Promise<boolean>`, `mergeBranchInto(repoRoot, branchName, intoBranch): Promise<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/git/merge.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isBranchMergedInto, mergeBranchInto } from '../../src/git/merge.js';
import { checkoutNewBranchAt, checkoutExistingBranch } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('mergeBranchInto and isBranchMergedInto', () => {
  it('merges a clean branch and reports it as merged', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/m', 'main');
    await writeFile(path.join(repo.dir, 'm.txt'), 'hi');
    await commitAll(repo.dir, 'add m.txt');
    await checkoutExistingBranch(repo.dir, 'main');
    expect(await isBranchMergedInto(repo.dir, 'feature/m', 'main')).toBe(false);
    const sha = await mergeBranchInto(repo.dir, 'feature/m', 'main');
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await isBranchMergedInto(repo.dir, 'feature/m', 'main')).toBe(true);
  });

  it('refuses to merge when the target branch is not checked out', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/n', 'main');
    await writeFile(path.join(repo.dir, 'n.txt'), 'hi');
    await commitAll(repo.dir, 'add n.txt');
    await expect(mergeBranchInto(repo.dir, 'feature/n', 'main')).rejects.toThrow(/not checked out/);
  });

  it('refuses to merge with a dirty working tree', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/o', 'main');
    await writeFile(path.join(repo.dir, 'o.txt'), 'hi');
    await commitAll(repo.dir, 'add o.txt');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(repo.dir, 'dirty.txt'), 'uncommitted');
    await expect(mergeBranchInto(repo.dir, 'feature/o', 'main')).rejects.toThrow(
      /uncommitted changes/,
    );
  });

  it('throws a plain git error when the branches actually conflict', async () => {
    repo = await createTempRepo();
    await checkoutNewBranchAt(repo.dir, 'feature/p', 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from branch\n');
    await commitAll(repo.dir, 'change readme on branch');
    await checkoutExistingBranch(repo.dir, 'main');
    await writeFile(path.join(repo.dir, 'README.md'), 'from main\n');
    await commitAll(repo.dir, 'change readme on main');
    await expect(mergeBranchInto(repo.dir, 'feature/p', 'main')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/git/merge.test.ts`
Expected: FAIL — `src/git/merge.ts` does not exist.

- [ ] **Step 3: Write `src/git/merge.ts`**

```ts
import { getCurrentBranch } from './branch.js';
import { isWorkingTreeClean, openRepo } from './repository.js';

export async function isBranchMergedInto(
  repoRoot: string,
  branchName: string,
  intoBranch: string,
): Promise<boolean> {
  try {
    await openRepo(repoRoot).raw(['merge-base', '--is-ancestor', branchName, intoBranch]);
    return true;
  } catch {
    return false;
  }
}

export async function mergeBranchInto(
  repoRoot: string,
  branchName: string,
  intoBranch: string,
): Promise<string> {
  const currentBranch = await getCurrentBranch(repoRoot);
  if (currentBranch !== intoBranch) {
    throw new Error(
      `Refusing to merge: "${intoBranch}" is not checked out in ${repoRoot} (found "${currentBranch}")`,
    );
  }
  if (!(await isWorkingTreeClean(repoRoot))) {
    throw new Error(`Refusing to merge: ${repoRoot} has uncommitted changes`);
  }
  const git = openRepo(repoRoot);
  await git.merge([branchName, '--no-edit']);
  const log = await git.log(['-1']);
  if (!log.latest) throw new Error('Merge succeeded but produced no commit');
  return log.latest.hash;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/git/merge.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add git conflict preflight and merge helpers"
```

---

### Task 5: State schema and types

**Files:**

- Create: `src/state/types.ts`

**Interfaces:**

- Produces: `SliceStatus`, `Slice`, `RunContext`, `RunPlan`, `RunMeta` types, and `sliceSchema`, `slicesSchema`, `runContextSchema`, `runPlanSchema`, `runMetaSchema` zod schemas. `Slice.lastFeedback` (optional string) carries the reviewer's or verify command's most recent "changes requested" reason, read by the implement step's prompt on the next pass so feedback isn't silently discarded. `Slice.mergeAttempts` has no reader or writer in v1 (it was the removed Task 13's retry counter) — kept in the schema, always `0`, reserved for when conflict-handling returns; do not remove it or repurpose it for something else.

- [ ] **Step 1: Write the failing test**

```ts
// tests/state/types.test.ts
import { describe, expect, it } from 'vitest';
import { runMetaSchema, sliceSchema, slicesSchema } from '../../src/state/types.js';

describe('state schemas', () => {
  it('accepts a valid slice list', () => {
    const parsed = slicesSchema.parse([
      {
        id: 'add-auth-middleware',
        title: 'Add auth middleware',
        description: 'Add the auth middleware that checks the session token.',
        order: 0,
        status: 'pending',
        branch: 'jig/slice/run1/add-auth-middleware',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it('rejects an invalid slice status', () => {
    expect(() =>
      slicesSchema.parse([
        {
          id: 'x',
          title: 'x',
          description: 'x',
          order: 0,
          status: 'not-a-real-status',
          branch: 'x',
          reviewCycles: 0,
          mergeAttempts: 0,
        },
      ]),
    ).toThrow();
  });

  it('accepts a slice with lastFeedback set and defaults it to undefined when absent', () => {
    const withFeedback = sliceSchema.parse({
      id: 'x',
      title: 'x',
      description: 'x',
      order: 0,
      status: 'pending',
      branch: 'x',
      reviewCycles: 1,
      mergeAttempts: 0,
      lastFeedback: 'Missing a test for the error path.',
    });
    expect(withFeedback.lastFeedback).toBe('Missing a test for the error path.');

    const withoutFeedback = sliceSchema.parse({
      id: 'y',
      title: 'y',
      description: 'y',
      order: 0,
      status: 'pending',
      branch: 'y',
      reviewCycles: 0,
      mergeAttempts: 0,
    });
    expect(withoutFeedback.lastFeedback).toBeUndefined();
  });

  it('parses run meta', () => {
    const meta = runMetaSchema.parse({
      runId: 'abc12345',
      baseBranch: 'main',
      currentSliceId: null,
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:00.000Z',
    });
    expect(meta.runId).toBe('abc12345');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/state/types.test.ts`
Expected: FAIL — `src/state/types.ts` does not exist.

- [ ] **Step 3: Write `src/state/types.ts`**

```ts
import { z } from 'zod';

export const sliceStatusSchema = z.enum([
  'pending',
  'implementing',
  'in_review',
  'ready_to_merge',
  'merged',
  'stuck',
]);
export type SliceStatus = z.infer<typeof sliceStatusSchema>;

export const sliceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  order: z.number().int().nonnegative(),
  status: sliceStatusSchema,
  branch: z.string().min(1),
  reviewCycles: z.number().int().nonnegative(),
  mergeAttempts: z.number().int().nonnegative(),
  lastFeedback: z.string().optional(),
});
export type Slice = z.infer<typeof sliceSchema>;

export const slicesSchema = z.array(sliceSchema);

export const runContextSchema = z.object({
  rawRequest: z.string(),
  classification: z.string(),
  repoSummary: z.string(),
  createdAt: z.string(),
});
export type RunContext = z.infer<typeof runContextSchema>;

export const runPlanSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});
export type RunPlan = z.infer<typeof runPlanSchema>;

export const runMetaSchema = z.object({
  runId: z.string().min(1),
  baseBranch: z.string().min(1),
  currentSliceId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunMeta = z.infer<typeof runMetaSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/state/types.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add run state schema and types"
```

---

### Task 6: State store

v1 keeps run state as plain gitignored JSON files under `.jig/<runId>/state/`
— no dedicated git branch, no state worktree. That mechanism was cut (see
Global Constraints): it was the single buggiest part of the original design
(an untracked nested worktree showing up as a dirty embedded repo in the
primary checkout, breaking `isWorkingTreeClean` checks everywhere) and its
only real payoff — resuming a run from a different machine by fetching a git
ref — serves the future multi-machine "software factory," not a working v1.
Crash recovery still works: state is still durable on local disk, and
`resume` still reads it back; you only lose surviving a wiped local disk,
which nothing else in v1 promises either.

**Files:**

- Create: `src/state/run-paths.ts`
- Create: `src/state/store.ts`
- Test: `tests/state/store.test.ts`

**Interfaces:**

- Consumes: zod schemas (Task 5).
- Produces: `RunPaths` type + `getRunPaths(repoRoot, runId): RunPaths`; `initializeRunState(repoRoot, runId, baseBranch): Promise<RunPaths>`; `loadRunState(repoRoot, runId): Promise<RunPaths>` (throws if the run's state directory doesn't exist); `readRunMeta/writeRunMeta`, `readContext/writeContext`, `readPlan/writePlan`, `readSlices/writeSlices`, all `(paths: RunPaths, ...) => Promise<...>`.

- [ ] **Step 1: Write `src/state/run-paths.ts`**

```ts
import path from 'node:path';

export interface RunPaths {
  runId: string;
  repoRoot: string;
  stateDir: string;
  workspaceDir: string;
}

export function getRunPaths(repoRoot: string, runId: string): RunPaths {
  return {
    runId,
    repoRoot,
    stateDir: path.join(repoRoot, '.jig', runId, 'state'),
    workspaceDir: path.join(repoRoot, '.jig', runId, 'workspace'),
  };
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/state/store.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeRunState,
  loadRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('state store', () => {
  it('initializes run state with a seeded run meta', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    const meta = await readRunMeta(paths);
    expect(meta.runId).toBe('run1');
    expect(meta.baseBranch).toBe('main');
    expect(await readSlices(paths)).toEqual([]);
  });

  it('round-trips slices through write and read', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    await writeSlices(paths, [
      {
        id: 's1',
        title: 'First slice',
        description: 'Does the first thing.',
        order: 0,
        status: 'pending',
        branch: 'jig/slice/run2/s1',
        reviewCycles: 0,
        mergeAttempts: 0,
      },
    ]);
    const slices = await readSlices(paths);
    expect(slices).toHaveLength(1);
    expect(slices[0].id).toBe('s1');
  });

  it('reloads an existing run via loadRunState', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    await writeRunMeta(paths, {
      runId: 'run3',
      baseBranch: 'main',
      currentSliceId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const reloaded = await loadRunState(repo.dir, 'run3');
    const meta = await readRunMeta(reloaded);
    expect(meta.runId).toBe('run3');
  });

  it('throws a clear error when the run does not exist', async () => {
    repo = await createTempRepo();
    await expect(loadRunState(repo.dir, 'no-such-run')).rejects.toThrow(/no-such-run/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/state/store.test.ts`
Expected: FAIL — `src/state/store.ts` does not exist.

- [ ] **Step 4: Write `src/state/store.ts`**

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRunPaths, type RunPaths } from './run-paths.js';
import {
  runContextSchema,
  runMetaSchema,
  runPlanSchema,
  slicesSchema,
  type RunContext,
  type RunMeta,
  type RunPlan,
  type Slice,
} from './types.js';

const CONTEXT_FILE = 'context.json';
const PLAN_FILE = 'plan.json';
const SLICES_FILE = 'slices.json';
const RUN_META_FILE = 'run-meta.json';

export async function initializeRunState(
  repoRoot: string,
  runId: string,
  baseBranch: string,
): Promise<RunPaths> {
  const paths = getRunPaths(repoRoot, runId);
  await mkdir(paths.stateDir, { recursive: true });
  await writeRunMeta(paths, {
    runId,
    baseBranch,
    currentSliceId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await writeSlices(paths, []);
  return paths;
}

export async function loadRunState(repoRoot: string, runId: string): Promise<RunPaths> {
  const paths = getRunPaths(repoRoot, runId);
  if (!existsSync(path.join(paths.stateDir, RUN_META_FILE))) {
    throw new Error(`No run found with id "${runId}" (expected state at ${paths.stateDir})`);
  }
  return paths;
}

export async function readRunMeta(paths: RunPaths): Promise<RunMeta> {
  return runMetaSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, RUN_META_FILE), 'utf-8')),
  );
}

export async function writeRunMeta(paths: RunPaths, meta: RunMeta): Promise<void> {
  await writeJsonFile(paths.stateDir, RUN_META_FILE, runMetaSchema.parse(meta));
}

export async function readContext(paths: RunPaths): Promise<RunContext> {
  return runContextSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, CONTEXT_FILE), 'utf-8')),
  );
}

export async function writeContext(paths: RunPaths, context: RunContext): Promise<void> {
  await writeJsonFile(paths.stateDir, CONTEXT_FILE, runContextSchema.parse(context));
}

export async function readPlan(paths: RunPaths): Promise<RunPlan> {
  return runPlanSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, PLAN_FILE), 'utf-8')),
  );
}

export async function writePlan(paths: RunPaths, plan: RunPlan): Promise<void> {
  await writeJsonFile(paths.stateDir, PLAN_FILE, runPlanSchema.parse(plan));
}

export async function readSlices(paths: RunPaths): Promise<Slice[]> {
  return slicesSchema.parse(
    JSON.parse(await readFile(path.join(paths.stateDir, SLICES_FILE), 'utf-8')),
  );
}

export async function writeSlices(paths: RunPaths, slices: Slice[]): Promise<void> {
  await writeJsonFile(paths.stateDir, SLICES_FILE, slicesSchema.parse(slices));
}

async function writeJsonFile(dir: string, filename: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/state/store.test.ts`
Expected: PASS

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add local JSON run state store"
```

---

### Task 7: Config loader

**Files:**

- Create: `src/config/load-config.ts`
- Test: `tests/config/load-config.test.ts`

**Interfaces:**

- Produces: `JigConfig` type, `loadConfig(repoRoot): JigConfig`. `conflictResolveCap` has no reader in v1 (Task 13, its only consumer, was removed) — kept in the schema, reserved for when conflict-handling returns; do not remove it or repurpose it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/config/load-config.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../src/config/load-config.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    repo = await createTempRepo();
    const config = loadConfig(repo.dir);
    expect(config.mergeMode).toBe('manual');
    expect(config.reviewCycleCap).toBe(3);
    expect(config.conflictResolveCap).toBe(3);
    expect(config.inputSource).toBe('markdown-file');
    expect(config.providerCommand).toBe('claude');
  });

  it('merges values from jig.config.json over defaults', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'jig.config.json'),
      JSON.stringify({ mergeMode: 'auto', verifyCommand: 'npm test' }),
    );
    const config = loadConfig(repo.dir);
    expect(config.mergeMode).toBe('auto');
    expect(config.verifyCommand).toBe('npm test');
    expect(config.reviewCycleCap).toBe(3);
  });

  it('throws on an invalid mergeMode value', async () => {
    repo = await createTempRepo();
    await writeFile(
      path.join(repo.dir, 'jig.config.json'),
      JSON.stringify({ mergeMode: 'sometimes' }),
    );
    expect(() => loadConfig(repo.dir)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config/load-config.test.ts`
Expected: FAIL — `src/config/load-config.ts` does not exist.

- [ ] **Step 3: Write `src/config/load-config.ts`**

```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  mergeMode: z.enum(['manual', 'auto']).default('manual'),
  reviewCycleCap: z.number().int().positive().default(3),
  conflictResolveCap: z.number().int().positive().default(3),
  verifyCommand: z.string().optional(),
  inputSource: z.enum(['markdown-file']).default('markdown-file'),
  providerCommand: z.string().default('claude'),
});
export type JigConfig = z.infer<typeof configSchema>;

export function loadConfig(repoRoot: string): JigConfig {
  const configPath = path.join(repoRoot, 'jig.config.json');
  if (!existsSync(configPath)) return configSchema.parse({});
  return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/config/load-config.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add jig.config.json loader"
```

---

### Task 8: Agent provider abstraction, fake provider, structured output

**Files:**

- Create: `src/strategies/provider/types.ts`
- Create: `src/strategies/provider/fake.ts`
- Create: `src/orchestrator/structured-output.ts`
- Test: `tests/orchestrator/structured-output.test.ts`

**Interfaces:**

- Produces: `AgentRunInput`, `AgentRunResult`, `AgentProvider` interface (provider/types.ts); `FakeAgentProvider` class taking a handler function (provider/fake.ts); `STRUCTURED_OUTPUT_FILENAME`, `structuredOutputPath(cwd)`, `structuredOutputInstruction()`, `resetStructuredOutput(cwd): Promise<void>`, `readStructuredOutput<T>(cwd, parse)` (orchestrator/structured-output.ts). `resetStructuredOutput` deletes any existing output file at `cwd` (no-op if absent) — callers run it immediately before every `provider.run()` call that expects structured output, so a provider that fails to write a fresh file can never cause a stale prior result (e.g. a previous "approved: true") to be silently re-read.

- [ ] **Step 1: Write `src/strategies/provider/types.ts`**

```ts
export interface AgentRunInput {
  cwd: string;
  prompt: string;
}

export interface AgentRunResult {
  success: boolean;
  output: string;
}

export interface AgentProvider {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
```

- [ ] **Step 2: Write `src/strategies/provider/fake.ts`**

```ts
import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export type FakeAgentHandler = (input: AgentRunInput) => Promise<AgentRunResult> | AgentRunResult;

export class FakeAgentProvider implements AgentProvider {
  constructor(private readonly handler: FakeAgentHandler) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.handler(input);
  }
}
```

- [ ] **Step 3: Write the failing test for structured output**

```ts
// tests/orchestrator/structured-output.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  readStructuredOutput,
  resetStructuredOutput,
  structuredOutputInstruction,
  structuredOutputPath,
} from '../../src/orchestrator/structured-output.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('structured output helper', () => {
  it('builds an instruction that names the expected file', () => {
    expect(structuredOutputInstruction()).toContain('.jig-step-output.json');
  });

  it('reads and validates the file the provider wrote', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-output-'));
    const schema = z.object({ approved: z.boolean() });
    await writeFile(structuredOutputPath(dir), JSON.stringify({ approved: true }));
    const result = await readStructuredOutput(dir, (raw) => schema.parse(raw));
    expect(result.approved).toBe(true);
  });

  it('throws a clear error when the file was not written', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-output-'));
    await expect(readStructuredOutput(dir, (raw) => raw)).rejects.toThrow();
  });

  it('reset removes an existing file so a stale result cannot be re-read', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-output-'));
    await writeFile(structuredOutputPath(dir), JSON.stringify({ approved: true }));
    await resetStructuredOutput(dir);
    await expect(readStructuredOutput(dir, (raw) => raw)).rejects.toThrow();
  });

  it('reset is a no-op when no file exists yet', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-output-'));
    await expect(resetStructuredOutput(dir)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator/structured-output.test.ts`
Expected: FAIL — `src/orchestrator/structured-output.ts` does not exist.

- [ ] **Step 5: Write `src/orchestrator/structured-output.ts`**

```ts
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export const STRUCTURED_OUTPUT_FILENAME = '.jig-step-output.json';

export function structuredOutputPath(cwd: string): string {
  return path.join(cwd, STRUCTURED_OUTPUT_FILENAME);
}

export function structuredOutputInstruction(): string {
  return [
    `When you are completely done, write your result as a single JSON object to the file`,
    `"${STRUCTURED_OUTPUT_FILENAME}" in the current directory. Do not wrap it in markdown`,
    `code fences and do not include any other content in that file.`,
  ].join(' ');
}

export async function resetStructuredOutput(cwd: string): Promise<void> {
  await rm(structuredOutputPath(cwd), { force: true });
}

export async function readStructuredOutput<T>(cwd: string, parse: (raw: unknown) => T): Promise<T> {
  const raw = JSON.parse(await readFile(structuredOutputPath(cwd), 'utf-8'));
  return parse(raw);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/orchestrator/structured-output.test.ts`
Expected: PASS

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add agent provider abstraction and structured output helper"
```

---

### Task 9: Input source — markdown file

**Files:**

- Create: `src/strategies/input-source/types.ts`
- Create: `src/strategies/input-source/markdown-file.ts`
- Test: `tests/strategies/input-source/markdown-file.test.ts`

**Interfaces:**

- Produces: `InputSource` interface (`resolve(): Promise<string>`); `MarkdownFileInputSource` class.

- [ ] **Step 1: Write `src/strategies/input-source/types.ts`**

```ts
export interface InputSource {
  resolve(): Promise<string>;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/strategies/input-source/markdown-file.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownFileInputSource } from '../../../src/strategies/input-source/markdown-file.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('MarkdownFileInputSource', () => {
  it('resolves the file contents', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-input-'));
    const filePath = path.join(dir, 'request.md');
    await writeFile(filePath, '# Add feature X\n\nDetails here.');
    const source = new MarkdownFileInputSource(filePath);
    expect(await source.resolve()).toContain('Add feature X');
  });

  it('throws a clear error when the file does not exist', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-input-'));
    const source = new MarkdownFileInputSource(path.join(dir, 'missing.md'));
    await expect(source.resolve()).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/strategies/input-source/markdown-file.test.ts`
Expected: FAIL — `src/strategies/input-source/markdown-file.ts` does not exist.

- [ ] **Step 4: Write `src/strategies/input-source/markdown-file.ts`**

```ts
import { readFile } from 'node:fs/promises';
import type { InputSource } from './types.js';

export class MarkdownFileInputSource implements InputSource {
  constructor(private readonly filePath: string) {}

  async resolve(): Promise<string> {
    return readFile(this.filePath, 'utf-8');
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/strategies/input-source/markdown-file.test.ts`
Expected: PASS

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add markdown-file input source"
```

---

### Task 10: Prepare pipeline

**Files:**

- Create: `src/orchestrator/prompts.ts`
- Create: `src/orchestrator/prepare.ts`
- Test: `tests/orchestrator/prepare.test.ts`

**Interfaces:**

- Consumes: `InputSource` (Task 9); `AgentProvider`, `FakeAgentProvider` (Task 8); `structuredOutputInstruction`, `resetStructuredOutput`, `readStructuredOutput` (Task 8); `initializeRunState`, `writeContext`, `writePlan`, `writeSlices`, `writeRunMeta`, `readRunMeta` (Task 6); `runContextSchema`, `runPlanSchema`, `slicesSchema` (Task 5); `getCurrentBranch` (Task 2).
- Produces: `generateRunId(): string`; `prepareRun(options: PrepareOptions): Promise<RunMeta>` where `PrepareOptions = { repoRoot: string; inputSource: InputSource; provider: AgentProvider }`. On return, `RunMeta.currentSliceId` is set to the first slice (lowest `order`), or stays `null` if the slice plan came back empty.

- [ ] **Step 1: Write `src/orchestrator/prompts.ts`**

```ts
import { structuredOutputInstruction } from './structured-output.js';

export function buildContextPrompt(rawRequest: string): string {
  return [
    'You are the context-building step of an automated SDLC pipeline.',
    'Read the following request, then explore this repository as needed to understand',
    'the relevant existing code.',
    '',
    '--- REQUEST START ---',
    rawRequest,
    '--- REQUEST END ---',
    '',
    'Produce: a one- or two-word classification of the request (e.g. "feature", "bug-fix",',
    '"refactor"), and a concise summary of the repository context relevant to it.',
    '',
    `Respond with JSON matching: { "classification": string, "repoSummary": string }.`,
    structuredOutputInstruction(),
  ].join('\n');
}

export function buildFeaturePlanPrompt(rawRequest: string, repoSummary: string): string {
  return [
    'You are the feature-planning step of an automated SDLC pipeline.',
    '',
    '--- REQUEST ---',
    rawRequest,
    '',
    '--- REPOSITORY CONTEXT ---',
    repoSummary,
    '',
    'Produce a plan: a summary of what will change, the overall approach, and the list of',
    'affected areas of the codebase.',
    '',
    `Respond with JSON matching: { "summary": string, "approach": string, "affectedAreas": string[] }.`,
    structuredOutputInstruction(),
  ].join('\n');
}

export function buildSlicePlanPrompt(planSummary: string, planApproach: string): string {
  return [
    'You are the PR-slicing step of an automated SDLC pipeline.',
    '',
    '--- PLAN SUMMARY ---',
    planSummary,
    '',
    '--- APPROACH ---',
    planApproach,
    '',
    'Break this plan into an ordered sequence of small, independently reviewable slices.',
    'Each slice must be implementable and mergeable on its own, in the given order.',
    '',
    'Respond with JSON matching an array of:',
    '{ "id": string (kebab-case, unique), "title": string, "description": string }.',
    'Order the array the way the slices must be implemented.',
    structuredOutputInstruction(),
  ].join('\n');
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/orchestrator/prepare.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { prepareRun } from '../../src/orchestrator/prepare.js';
import { MarkdownFileInputSource } from '../../src/strategies/input-source/markdown-file.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import { loadRunState, readContext, readPlan, readSlices } from '../../src/state/store.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('prepareRun', () => {
  it('runs context, plan, and slice-plan steps and persists the result', async () => {
    repo = await createTempRepo();
    const requestPath = path.join(repo.dir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint');

    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      call += 1;
      if (call === 1) {
        await writeFile(
          structuredOutputPath(input.cwd),
          JSON.stringify({ classification: 'feature', repoSummary: 'An Express app.' }),
        );
      } else if (call === 2) {
        await writeFile(
          structuredOutputPath(input.cwd),
          JSON.stringify({
            summary: 'Add /health endpoint',
            approach: 'Add a route returning 200 OK',
            affectedAreas: ['src/routes'],
          }),
        );
      } else {
        await writeFile(
          structuredOutputPath(input.cwd),
          JSON.stringify([
            { id: 'add-health-route', title: 'Add health route', description: 'Add GET /health' },
          ]),
        );
      }
      return { success: true, output: 'done' };
    });

    const meta = await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });

    expect(meta.baseBranch).toBe('main');
    expect(meta.currentSliceId).toBe('add-health-route');
    const paths = await loadRunState(repo.dir, meta.runId);
    const context = await readContext(paths);
    expect(context.classification).toBe('feature');
    const plan = await readPlan(paths);
    expect(plan.summary).toContain('/health');
    const slices = await readSlices(paths);
    expect(slices).toHaveLength(1);
    expect(slices[0].status).toBe('pending');
    expect(slices[0].branch).toBe(`jig/slice/${meta.runId}/add-health-route`);
  });

  it('runs the planning steps with the real repository as cwd, not an empty scratch directory', async () => {
    repo = await createTempRepo();
    const requestPath = path.join(repo.dir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint');

    const seenCwds: string[] = [];
    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      seenCwds.push(input.cwd);
      call += 1;
      const output =
        call === 1
          ? { classification: 'feature', repoSummary: 'An Express app.' }
          : call === 2
            ? { summary: 'Add /health endpoint', approach: 'Add a route', affectedAreas: ['src'] }
            : [
                {
                  id: 'add-health-route',
                  title: 'Add health route',
                  description: 'Add GET /health',
                },
              ];
      await writeFile(structuredOutputPath(input.cwd), JSON.stringify(output));
      return { success: true, output: 'done' };
    });

    await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });

    expect(seenCwds).toEqual([repo.dir, repo.dir, repo.dir]);
  });

  it('leaves no structured-output file behind in the repo root once done', async () => {
    repo = await createTempRepo();
    const requestPath = path.join(repo.dir, 'request.md');
    await writeFile(requestPath, '# Add a health check endpoint');

    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      call += 1;
      const output =
        call === 1
          ? { classification: 'feature', repoSummary: 'An Express app.' }
          : call === 2
            ? { summary: 'Add /health endpoint', approach: 'Add a route', affectedAreas: ['src'] }
            : [
                {
                  id: 'add-health-route',
                  title: 'Add health route',
                  description: 'Add GET /health',
                },
              ];
      await writeFile(structuredOutputPath(input.cwd), JSON.stringify(output));
      return { success: true, output: 'done' };
    });

    await prepareRun({
      repoRoot: repo.dir,
      inputSource: new MarkdownFileInputSource(requestPath),
      provider,
    });

    expect(existsSync(structuredOutputPath(repo.dir))).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator/prepare.test.ts`
Expected: FAIL — `src/orchestrator/prepare.ts` does not exist.

- [ ] **Step 4: Write `src/orchestrator/prepare.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getCurrentBranch } from '../git/branch.js';
import type { InputSource } from '../strategies/input-source/types.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import {
  initializeRunState,
  readRunMeta,
  writeContext,
  writePlan,
  writeRunMeta,
  writeSlices,
} from '../state/store.js';
import type { RunMeta, Slice } from '../state/types.js';
import { buildContextPrompt, buildFeaturePlanPrompt, buildSlicePlanPrompt } from './prompts.js';
import { readStructuredOutput, resetStructuredOutput } from './structured-output.js';

export interface PrepareOptions {
  repoRoot: string;
  inputSource: InputSource;
  provider: AgentProvider;
}

const contextOutputSchema = z.object({ classification: z.string(), repoSummary: z.string() });
const planOutputSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});
const sliceOutputSchema = z.array(
  z.object({ id: z.string().min(1), title: z.string().min(1), description: z.string().min(1) }),
);

export function generateRunId(): string {
  return randomBytes(4).toString('hex');
}

export async function prepareRun(options: PrepareOptions): Promise<RunMeta> {
  const { repoRoot, inputSource, provider } = options;
  const rawRequest = await inputSource.resolve();
  const baseBranch = await getCurrentBranch(repoRoot);
  const runId = generateRunId();
  const paths = await initializeRunState(repoRoot, runId, baseBranch);

  // Planning steps run with cwd = repoRoot (not an empty scratch directory) so
  // the provider can actually explore the repository its own prompt asks it
  // to. The structured-output file this produces lands in repoRoot too —
  // reset before each call and never left behind (see Task 1's .gitignore).
  await resetStructuredOutput(repoRoot);
  const contextResult = await provider.run({
    cwd: repoRoot,
    prompt: buildContextPrompt(rawRequest),
  });
  if (!contextResult.success) throw new Error(`Context step failed: ${contextResult.output}`);
  const contextOutput = await readStructuredOutput(repoRoot, (raw) =>
    contextOutputSchema.parse(raw),
  );
  await writeContext(paths, {
    rawRequest,
    classification: contextOutput.classification,
    repoSummary: contextOutput.repoSummary,
    createdAt: new Date().toISOString(),
  });

  await resetStructuredOutput(repoRoot);
  const planResult = await provider.run({
    cwd: repoRoot,
    prompt: buildFeaturePlanPrompt(rawRequest, contextOutput.repoSummary),
  });
  if (!planResult.success) throw new Error(`Feature-plan step failed: ${planResult.output}`);
  const planOutput = await readStructuredOutput(repoRoot, (raw) => planOutputSchema.parse(raw));
  await writePlan(paths, planOutput);

  await resetStructuredOutput(repoRoot);
  const sliceResult = await provider.run({
    cwd: repoRoot,
    prompt: buildSlicePlanPrompt(planOutput.summary, planOutput.approach),
  });
  if (!sliceResult.success) throw new Error(`Slice-plan step failed: ${sliceResult.output}`);
  const sliceOutput = await readStructuredOutput(repoRoot, (raw) => sliceOutputSchema.parse(raw));
  await resetStructuredOutput(repoRoot);

  const slices: Slice[] = sliceOutput.map((slice, order) => ({
    ...slice,
    order,
    status: 'pending',
    branch: `jig/slice/${runId}/${slice.id}`,
    reviewCycles: 0,
    mergeAttempts: 0,
  }));
  await writeSlices(paths, slices);

  const firstSlice = [...slices].sort((a, b) => a.order - b.order)[0];
  const meta = await readRunMeta(paths);
  await writeRunMeta(paths, {
    ...meta,
    currentSliceId: firstSlice?.id ?? null,
    updatedAt: new Date().toISOString(),
  });

  return readRunMeta(paths);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/orchestrator/prepare.test.ts`
Expected: PASS

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add prepare pipeline (context, feature plan, slice plan)"
```

---

### Task 11: Reconciler — implement step

**Files:**

- Create: `src/orchestrator/implement-step.ts`
- Test: `tests/orchestrator/implement-step.test.ts`

**Interfaces:**

- Consumes: `AgentProvider`, `FakeAgentProvider` (Task 8); `RunPaths` (Task 6); `Slice` (Task 5, including `lastFeedback`); `addWorktreeForNewBranch`, `worktreeExists` (Task 3); `localBranchExists`, `checkoutExistingBranch`, `checkoutNewBranchAt` (Task 2); `commitAll` (Task 2).
- Produces: `runImplementStep(input: ImplementStepInput): Promise<void>` where `ImplementStepInput = { repoRoot: string; paths: RunPaths; slice: Slice; baseBranch: string; provider: AgentProvider }`; on return, mutates `slice.status` to `'in_review'` (throws `ImplementStepFailedError` on provider failure, leaving `slice.status` untouched). When `slice.lastFeedback` is set (a prior review or verify run requested changes), the prompt includes it so the re-implementation pass actually addresses it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator/implement-step.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ImplementStepFailedError,
  runImplementStep,
} from '../../src/orchestrator/implement-step.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { getRunPaths } from '../../src/state/run-paths.js';
import { isWorkingTreeClean } from '../../src/git/repository.js';
import { getCurrentBranch } from '../../src/git/branch.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

function makeSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: 's1',
    title: 'First slice',
    description: 'Do the first thing.',
    order: 0,
    status: 'pending',
    branch: 'jig/slice/run1/s1',
    reviewCycles: 0,
    mergeAttempts: 0,
    ...overrides,
  };
}

describe('runImplementStep', () => {
  it('creates the workspace, runs the provider, commits, and advances status', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run1');
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(slice.status).toBe('in_review');
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('jig/slice/run1/s1');
    expect(await isWorkingTreeClean(paths.workspaceDir)).toBe(true);
  });

  it('reuses the existing branch on a second call instead of recreating it', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run2');
    const slice = makeSlice({ branch: 'jig/slice/run2/s1' });
    let calls = 0;
    const provider = new FakeAgentProvider(async (input) => {
      calls += 1;
      await writeFile(path.join(input.cwd, `pass-${calls}.txt`), 'x');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });
    slice.status = 'pending';
    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(calls).toBe(2);
    expect(await getCurrentBranch(paths.workspaceDir)).toBe('jig/slice/run2/s1');
  });

  it('throws and leaves status untouched when the provider fails', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run3');
    const slice = makeSlice({ branch: 'jig/slice/run3/s1' });
    const provider = new FakeAgentProvider(async () => ({ success: false, output: 'boom' }));

    await expect(
      runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider }),
    ).rejects.toThrow(ImplementStepFailedError);
    expect(slice.status).toBe('pending');
  });

  it('includes lastFeedback in the prompt when a previous review requested changes', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4');
    const slice = makeSlice({
      branch: 'jig/slice/run4/s1',
      lastFeedback: 'The health check must also verify the database connection.',
    });
    let seenPrompt = '';
    const provider = new FakeAgentProvider(async (input) => {
      seenPrompt = input.prompt;
      await writeFile(path.join(input.cwd, 'health.ts'), 'export const health = () => "ok";\n');
      return { success: true, output: 'implemented' };
    });

    await runImplementStep({ repoRoot: repo.dir, paths, slice, baseBranch: 'main', provider });

    expect(seenPrompt).toContain('verify the database connection');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator/implement-step.test.ts`
Expected: FAIL — `src/orchestrator/implement-step.ts` does not exist.

- [ ] **Step 3: Write `src/orchestrator/implement-step.ts`**

```ts
import type { AgentProvider } from '../strategies/provider/types.js';
import { checkoutExistingBranch, checkoutNewBranchAt, localBranchExists } from '../git/branch.js';
import { commitAll } from '../git/repository.js';
import { addWorktreeForNewBranch, worktreeExists } from '../git/worktree.js';
import type { RunPaths } from '../state/run-paths.js';
import type { Slice } from '../state/types.js';

export class ImplementStepFailedError extends Error {
  constructor(sliceId: string, providerOutput: string) {
    super(`Implement step failed for slice "${sliceId}": ${providerOutput}`);
  }
}

export interface ImplementStepInput {
  repoRoot: string;
  paths: RunPaths;
  slice: Slice;
  baseBranch: string;
  provider: AgentProvider;
}

export async function runImplementStep(input: ImplementStepInput): Promise<void> {
  const { repoRoot, paths, slice, baseBranch, provider } = input;
  await ensureWorkspaceOnBranch(repoRoot, paths.workspaceDir, slice.branch, baseBranch);

  const result = await provider.run({
    cwd: paths.workspaceDir,
    prompt: buildImplementPrompt(slice),
  });
  if (!result.success) {
    throw new ImplementStepFailedError(slice.id, result.output);
  }

  await commitAll(paths.workspaceDir, `jig: implement ${slice.id} — ${slice.title}`);
  slice.status = 'in_review';
}

function buildImplementPrompt(slice: Slice): string {
  const lines = [
    `You are implementing one slice of a larger, already-planned feature.`,
    '',
    `Slice: ${slice.title}`,
    `Description: ${slice.description}`,
  ];
  if (slice.lastFeedback) {
    lines.push(
      '',
      'A previous attempt at this slice was reviewed and changes were requested.',
      'Address this feedback specifically:',
      slice.lastFeedback,
    );
  }
  lines.push(
    '',
    'Make the necessary code changes in this repository to complete this slice.',
    'Do not commit — leave the changes in the working tree.',
  );
  return lines.join('\n');
}

async function ensureWorkspaceOnBranch(
  repoRoot: string,
  workspacePath: string,
  branchName: string,
  baseBranch: string,
): Promise<void> {
  if (!(await worktreeExists(repoRoot, workspacePath))) {
    await addWorktreeForNewBranch(repoRoot, workspacePath, branchName, baseBranch);
    return;
  }
  if (await localBranchExists(repoRoot, branchName)) {
    await checkoutExistingBranch(workspacePath, branchName);
    return;
  }
  await checkoutNewBranchAt(workspacePath, branchName, baseBranch);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/orchestrator/implement-step.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add reconciler implement step"
```

---

### Task 12: Reconciler — review and verify step

**Files:**

- Create: `src/orchestrator/review-step.ts`
- Test: `tests/orchestrator/review-step.test.ts`

**Interfaces:**

- Consumes: `AgentProvider`, `FakeAgentProvider` (Task 8); `structuredOutputInstruction`, `resetStructuredOutput`, `readStructuredOutput` (Task 8); `Slice` (Task 5); `JigConfig` (Task 7).
- Produces: `runReviewStep(input: ReviewStepInput): Promise<void>` where `ReviewStepInput = { paths: RunPaths; slice: Slice; provider: AgentProvider; config: JigConfig }`. Mutates `slice.status` to one of `'pending'` (changes requested, under cap), `'stuck'` (cap exceeded), or `'ready_to_merge'` (approved and verify passed); increments `slice.reviewCycles` on a changes-requested outcome. On a changes-requested outcome, sets `slice.lastFeedback` to the reviewer's feedback (or a verify-failure message) so Task 11's implement step can act on it; clears it on approval.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator/review-step.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runReviewStep } from '../../src/orchestrator/review-step.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import { getRunPaths } from '../../src/state/run-paths.js';
import type { JigConfig } from '../../src/config/load-config.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

function makeSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: 's1',
    title: 'First slice',
    description: 'Do the first thing.',
    order: 0,
    status: 'in_review',
    branch: 'jig/slice/run1/s1',
    reviewCycles: 0,
    mergeAttempts: 0,
    ...overrides,
  };
}

const baseConfig: JigConfig = {
  mergeMode: 'manual',
  reviewCycleCap: 3,
  conflictResolveCap: 3,
  inputSource: 'markdown-file',
  providerCommand: 'claude',
};

describe('runReviewStep', () => {
  it('moves to ready_to_merge when the reviewer approves and no verify command is set', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run1');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    expect(slice.status).toBe('ready_to_merge');
  });

  it('loops back to pending with an incremented cycle count when changes are requested', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run2');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Missing a test.' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: baseConfig });

    expect(slice.status).toBe('pending');
    expect(slice.reviewCycles).toBe(1);
  });

  it('marks the slice stuck once the review cycle cap is exceeded', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run3');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice({ reviewCycles: 3 });
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: false, feedback: 'Still wrong.' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: { ...baseConfig, reviewCycleCap: 3 } });

    expect(slice.status).toBe('stuck');
  });

  it('treats a failing verify command as changes requested even if the reviewer approved', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run4');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({
      paths,
      slice,
      provider,
      config: { ...baseConfig, verifyCommand: 'exit 1' },
    });

    expect(slice.status).toBe('pending');
    expect(slice.reviewCycles).toBe(1);
  });

  it('reaches ready_to_merge when both the reviewer and the verify command pass', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run5');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify({ approved: true, feedback: '' }),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({
      paths,
      slice,
      provider,
      config: { ...baseConfig, verifyCommand: 'exit 0' },
    });

    expect(slice.status).toBe('ready_to_merge');
  });

  it('records the reviewer feedback on the slice and clears it once approved', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run6');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice = makeSlice();
    let approve = false;
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(
        structuredOutputPath(input.cwd),
        JSON.stringify(
          approve
            ? { approved: true, feedback: '' }
            : { approved: false, feedback: 'Add error handling for a missing database.' },
        ),
      );
      return { success: true, output: 'reviewed' };
    });

    await runReviewStep({ paths, slice, provider, config: baseConfig });
    expect(slice.lastFeedback).toBe('Add error handling for a missing database.');

    approve = true;
    await runReviewStep({ paths, slice, provider, config: baseConfig });
    expect(slice.lastFeedback).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator/review-step.test.ts`
Expected: FAIL — `src/orchestrator/review-step.ts` does not exist.

- [ ] **Step 3: Write `src/orchestrator/review-step.ts`**

```ts
import { execa } from 'execa';
import { z } from 'zod';
import type { JigConfig } from '../config/load-config.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import type { RunPaths } from '../state/run-paths.js';
import type { Slice } from '../state/types.js';
import {
  readStructuredOutput,
  resetStructuredOutput,
  structuredOutputInstruction,
} from './structured-output.js';

const reviewOutputSchema = z.object({ approved: z.boolean(), feedback: z.string() });

export interface ReviewStepInput {
  paths: RunPaths;
  slice: Slice;
  provider: AgentProvider;
  config: JigConfig;
}

export async function runReviewStep(input: ReviewStepInput): Promise<void> {
  const { paths, slice, provider, config } = input;

  await resetStructuredOutput(paths.workspaceDir);
  const reviewResult = await provider.run({
    cwd: paths.workspaceDir,
    prompt: buildReviewPrompt(slice),
  });
  if (!reviewResult.success) {
    requestChanges(
      slice,
      config.reviewCycleCap,
      `Review step failed to run: ${reviewResult.output}`,
    );
    return;
  }
  const review = await readStructuredOutput(paths.workspaceDir, (raw) =>
    reviewOutputSchema.parse(raw),
  );
  if (!review.approved) {
    requestChanges(slice, config.reviewCycleCap, review.feedback);
    return;
  }

  if (config.verifyCommand && !(await runVerifyCommand(paths.workspaceDir, config.verifyCommand))) {
    requestChanges(
      slice,
      config.reviewCycleCap,
      `The reviewer approved this slice, but the verify command ("${config.verifyCommand}") failed.`,
    );
    return;
  }

  slice.lastFeedback = undefined;
  slice.status = 'ready_to_merge';
}

function requestChanges(slice: Slice, reviewCycleCap: number, feedback: string): void {
  slice.reviewCycles += 1;
  slice.lastFeedback = feedback;
  slice.status = slice.reviewCycles >= reviewCycleCap ? 'stuck' : 'pending';
}

async function runVerifyCommand(cwd: string, verifyCommand: string): Promise<boolean> {
  try {
    await execa(verifyCommand, { cwd, shell: true });
    return true;
  } catch {
    return false;
  }
}

function buildReviewPrompt(slice: Slice): string {
  return [
    'You are the review step of an automated SDLC pipeline.',
    `Review the uncommitted and committed changes in this worktree for the slice below.`,
    '',
    `Slice: ${slice.title}`,
    `Description: ${slice.description}`,
    '',
    'Decide whether this slice is ready to merge as-is.',
    'Respond with JSON matching: { "approved": boolean, "feedback": string }.',
    'If approved is false, feedback must explain exactly what needs to change.',
    structuredOutputInstruction(),
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/orchestrator/review-step.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add reconciler review and verify step with bounded retry"
```

---

### Task 13: Removed — conflict preflight and resolve-conflicts

This task was cut from the plan. Review surfaced it as the second-buggiest
area of the original design (ignored provider failure results, assumed
workspace worktree state that may not exist after a restart), and what it
guards against is rare in a sequential v1: main only drifts under a slice
branch from your own unrelated commits or the passage of time under
manual-merge mode. See Global Constraints for the accepted alternative —
`mergeBranchInto` (Task 4) throws a plain git error on a real conflict, and
you resolve it by hand in the workspace worktree, then re-run `jig merge`.

---

### Task 14: Merge strategies and slice advancement

**Files:**

- Create: `src/strategies/merge/types.ts`
- Create: `src/strategies/merge/manual.ts`
- Create: `src/strategies/merge/auto.ts`
- Create: `src/orchestrator/advance.ts`
- Test: `tests/orchestrator/advance.test.ts`

**Interfaces:**

- Consumes: `mergeBranchInto`, `isBranchMergedInto` (Task 4); `Slice`, `RunMeta` (Task 5); `readSlices`, `writeSlices`, `readRunMeta`, `writeRunMeta` (Task 6); `checkoutExistingBranch` (Task 2).
- Produces: `MergeStrategy` interface (`merge(repoRoot, slice, baseBranch): Promise<void>`); `ManualMergeStrategy` (no-op — never merges); `AutoMergeStrategy` (calls `mergeBranchInto`); `advanceRun(input: AdvanceInput): Promise<AdvanceResult>` where `AdvanceInput = { repoRoot: string; paths: RunPaths; baseBranch: string; mergeStrategy: MergeStrategy }` — for the run's current slice, if its status is `'ready_to_merge'`, invokes `mergeStrategy.merge`; then (regardless of merge mode) checks whether the current slice's branch `isBranchMergedInto` the base branch and, if so, marks it `'merged'` and moves `currentSliceId` to the next pending slice by `order`. `AdvanceResult = { advanced: boolean; currentSliceId: string | null; complete: boolean }`.

- [ ] **Step 1: Write `src/strategies/merge/types.ts`**

```ts
import type { Slice } from '../../state/types.js';

export interface MergeStrategy {
  merge(repoRoot: string, slice: Slice, baseBranch: string): Promise<void>;
}
```

- [ ] **Step 2: Write `src/strategies/merge/manual.ts`**

```ts
import type { Slice } from '../../state/types.js';
import type { MergeStrategy } from './types.js';

export class ManualMergeStrategy implements MergeStrategy {
  async merge(_repoRoot: string, _slice: Slice, _baseBranch: string): Promise<void> {
    // Intentionally does nothing: merging into the base branch is left to the
    // operator's own git workflow. advanceRun still detects a manual merge by
    // checking git state directly, which is what lets `resume` continue.
  }
}
```

- [ ] **Step 3: Write `src/strategies/merge/auto.ts`**

```ts
import { mergeBranchInto } from '../../git/merge.js';
import type { Slice } from '../../state/types.js';
import type { MergeStrategy } from './types.js';

export class AutoMergeStrategy implements MergeStrategy {
  async merge(repoRoot: string, slice: Slice, baseBranch: string): Promise<void> {
    await mergeBranchInto(repoRoot, slice.branch, baseBranch);
  }
}
```

- [ ] **Step 4: Write the failing test for `advanceRun`**

```ts
// tests/orchestrator/advance.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { advanceRun } from '../../src/orchestrator/advance.js';
import { AutoMergeStrategy } from '../../src/strategies/merge/auto.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { checkoutNewBranchAt } from '../../src/git/branch.js';
import { commitAll } from '../../src/git/repository.js';
import { mergeBranchInto } from '../../src/git/merge.js';
import {
  initializeRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

function makeSlices(runId: string): Slice[] {
  return [
    {
      id: 'first',
      title: 'First',
      description: 'first',
      order: 0,
      status: 'ready_to_merge',
      branch: `jig/slice/${runId}/first`,
      reviewCycles: 0,
      mergeAttempts: 0,
    },
    {
      id: 'second',
      title: 'Second',
      description: 'second',
      order: 1,
      status: 'pending',
      branch: `jig/slice/${runId}/second`,
      reviewCycles: 0,
      mergeAttempts: 0,
    },
  ];
}

describe('advanceRun', () => {
  it('auto-merges, marks the slice merged, and advances currentSliceId', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run1', 'main');
    const slices = makeSlices('run1');
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });
    await checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(path.join(repo.dir, 'first.txt'), 'x');
    await commitAll(repo.dir, 'implement first');
    await (await import('../../src/git/branch.js')).checkoutExistingBranch(repo.dir, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.currentSliceId).toBe('second');
    expect(result.complete).toBe(false);
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices[0].status).toBe('merged');
  });

  it('detects a manual merge already performed and advances without merging itself', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run2', 'main');
    const slices = makeSlices('run2');
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });
    await checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(path.join(repo.dir, 'first.txt'), 'x');
    await commitAll(repo.dir, 'implement first');
    const branchModule = await import('../../src/git/branch.js');
    await branchModule.checkoutExistingBranch(repo.dir, 'main');
    await mergeBranchInto(repo.dir, slices[0].branch, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.currentSliceId).toBe('second');
    const updatedSlices = await readSlices(paths);
    expect(updatedSlices[0].status).toBe('merged');
  });

  it('does not advance and reports not advanced when the current slice is not merged yet', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run3', 'main');
    const slices = makeSlices('run3').map((s) =>
      s.id === 'first' ? { ...s, status: 'in_review' as const } : s,
    );
    await writeSlices(paths, slices);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'first' });

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.advanced).toBe(false);
    expect(result.currentSliceId).toBe('first');
  });

  it('reports complete once the last slice is merged', async () => {
    repo = await createTempRepo();
    const paths = await initializeRunState(repo.dir, 'run4', 'main');
    const slice: Slice = {
      id: 'only',
      title: 'Only',
      description: 'only',
      order: 0,
      status: 'ready_to_merge',
      branch: 'jig/slice/run4/only',
      reviewCycles: 0,
      mergeAttempts: 0,
    };
    await writeSlices(paths, [slice]);
    const meta = await readRunMeta(paths);
    await writeRunMeta(paths, { ...meta, currentSliceId: 'only' });
    await checkoutNewBranchAt(repo.dir, slice.branch, 'main');
    await writeFile(path.join(repo.dir, 'only.txt'), 'x');
    await commitAll(repo.dir, 'implement only');
    const branchModule = await import('../../src/git/branch.js');
    await branchModule.checkoutExistingBranch(repo.dir, 'main');

    const result = await advanceRun({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.complete).toBe(true);
    expect(result.currentSliceId).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator/advance.test.ts`
Expected: FAIL — `src/orchestrator/advance.ts` does not exist.

- [ ] **Step 6: Write `src/orchestrator/advance.ts`**

```ts
import { isBranchMergedInto } from '../git/merge.js';
import { readRunMeta, readSlices, writeRunMeta, writeSlices } from '../state/store.js';
import type { RunPaths } from '../state/run-paths.js';
import type { MergeStrategy } from '../strategies/merge/types.js';

export interface AdvanceInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
}

export interface AdvanceResult {
  advanced: boolean;
  currentSliceId: string | null;
  complete: boolean;
}

export async function advanceRun(input: AdvanceInput): Promise<AdvanceResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy } = input;
  const meta = await readRunMeta(paths);
  const slices = await readSlices(paths);
  const currentSlice = slices.find((slice) => slice.id === meta.currentSliceId);

  if (!currentSlice) {
    return { advanced: false, currentSliceId: meta.currentSliceId, complete: slices.length > 0 };
  }

  if (currentSlice.status === 'ready_to_merge') {
    await mergeStrategy.merge(repoRoot, currentSlice, baseBranch);
  }

  if (!(await isBranchMergedInto(repoRoot, currentSlice.branch, baseBranch))) {
    return { advanced: false, currentSliceId: meta.currentSliceId, complete: false };
  }

  currentSlice.status = 'merged';
  const nextSlice = slices
    .filter((slice) => slice.status !== 'merged')
    .sort((a, b) => a.order - b.order)[0];
  const nextSliceId = nextSlice?.id ?? null;

  await writeSlices(paths, slices);
  await writeRunMeta(paths, {
    ...meta,
    currentSliceId: nextSliceId,
    updatedAt: new Date().toISOString(),
  });

  return { advanced: true, currentSliceId: nextSliceId, complete: nextSliceId === null };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/orchestrator/advance.test.ts`
Expected: PASS

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add merge strategies and slice advancement"
```

---

### Task 15: Local PR-create strategy and the reconciler loop

**Files:**

- Create: `src/strategies/pr/types.ts`
- Create: `src/strategies/pr/local.ts`
- Create: `src/orchestrator/reconcile.ts`
- Test: `tests/strategies/pr/local.test.ts`
- Test: `tests/orchestrator/reconcile.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 5–12 and 14 (no Task 13 — removed).
- Produces: `PrCreateStrategy` interface (`create(paths, slice): Promise<void>`); `LocalPrCreateStrategy` (writes a PR description markdown file into the workspace); `runReconcilerPass(input: ReconcilePassInput): Promise<ReconcilePassResult>` where `ReconcilePassInput = { repoRoot: string; paths: RunPaths; baseBranch: string; provider: AgentProvider; config: JigConfig; mergeStrategy: MergeStrategy }` — does one dispatch, acting on the current slice's status, returning `{ blocked: boolean; reason?: string; complete: boolean }`. A merge conflict thrown by the merge strategy is caught here and turned into a `blocked` result rather than propagating as an unhandled error. This is the single mechanism every CLI command in Task 16 calls into.

- [ ] **Step 1: Write `src/strategies/pr/types.ts`**

```ts
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';

export interface PrCreateStrategy {
  create(paths: RunPaths, slice: Slice): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test for the local PR strategy**

```ts
// tests/strategies/pr/local.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalPrCreateStrategy } from '../../../src/strategies/pr/local.js';
import { getRunPaths } from '../../../src/state/run-paths.js';
import type { Slice } from '../../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

describe('LocalPrCreateStrategy', () => {
  it('writes a PR description file into the workspace', async () => {
    repo = await createTempRepo();
    const paths = getRunPaths(repo.dir, 'run1');
    await mkdir(paths.workspaceDir, { recursive: true });
    const slice: Slice = {
      id: 's1',
      title: 'Add health route',
      description: 'Adds GET /health returning 200.',
      order: 0,
      status: 'ready_to_merge',
      branch: 'jig/slice/run1/s1',
      reviewCycles: 0,
      mergeAttempts: 0,
    };

    await new LocalPrCreateStrategy().create(paths, slice);

    const content = await readFile(path.join(paths.workspaceDir, 'PR_DESCRIPTION.md'), 'utf-8');
    expect(content).toContain('Add health route');
    expect(content).toContain('Adds GET /health returning 200.');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/strategies/pr/local.test.ts`
Expected: FAIL — `src/strategies/pr/local.ts` does not exist.

- [ ] **Step 4: Write `src/strategies/pr/local.ts`**

```ts
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunPaths } from '../../state/run-paths.js';
import type { Slice } from '../../state/types.js';
import type { PrCreateStrategy } from './types.js';

export class LocalPrCreateStrategy implements PrCreateStrategy {
  async create(paths: RunPaths, slice: Slice): Promise<void> {
    const content = [`# ${slice.title}`, '', slice.description, ''].join('\n');
    await writeFile(path.join(paths.workspaceDir, 'PR_DESCRIPTION.md'), content, 'utf-8');
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/strategies/pr/local.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing test for the reconciler pass**

```ts
// tests/orchestrator/reconcile.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { runReconcilerPass } from '../../src/orchestrator/reconcile.js';
import { FakeAgentProvider } from '../../src/strategies/provider/fake.js';
import { ManualMergeStrategy } from '../../src/strategies/merge/manual.js';
import { structuredOutputPath } from '../../src/orchestrator/structured-output.js';
import {
  initializeRunState,
  readRunMeta,
  readSlices,
  writeRunMeta,
  writeSlices,
} from '../../src/state/store.js';
import type { JigConfig } from '../../src/config/load-config.js';
import type { Slice } from '../../src/state/types.js';
import { createTempRepo, type TempRepo } from '../support/temp-repo.js';

let repo: TempRepo;

afterEach(async () => {
  await repo?.cleanup();
});

const baseConfig: JigConfig = {
  mergeMode: 'manual',
  reviewCycleCap: 3,
  conflictResolveCap: 3,
  inputSource: 'markdown-file',
  providerCommand: 'claude',
};

async function setUpSingleSliceRun(
  repoDir: string,
  runId: string,
): Promise<ReturnType<typeof initializeRunState>> {
  const paths = await initializeRunState(repoDir, runId, 'main');
  const slice: Slice = {
    id: 'only',
    title: 'Only slice',
    description: 'Do the only thing.',
    order: 0,
    status: 'pending',
    branch: `jig/slice/${runId}/only`,
    reviewCycles: 0,
    mergeAttempts: 0,
  };
  await writeSlices(paths, [slice]);
  const meta = await readRunMeta(paths);
  await writeRunMeta(paths, { ...meta, currentSliceId: 'only' });
  return paths;
}

describe('runReconcilerPass', () => {
  it('drives a pending slice to in_review on one pass', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run1');
    const provider = new FakeAgentProvider(async (input) => {
      await writeFile(`${input.cwd}/impl.txt`, 'x');
      return { success: true, output: 'ok' };
    });

    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(false);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('in_review');
  });

  it('reports blocked with a reason when manual mode reaches ready_to_merge', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run2');
    let call = 0;
    const provider = new FakeAgentProvider(async (input) => {
      call += 1;
      if (call === 1) {
        await writeFile(`${input.cwd}/impl.txt`, 'x');
      } else {
        await writeFile(
          structuredOutputPath(input.cwd),
          JSON.stringify({ approved: true, feedback: '' }),
        );
      }
      return { success: true, output: 'ok' };
    });

    await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });
    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider,
      config: baseConfig,
      mergeStrategy: new ManualMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/manual/i);
    const slices = await readSlices(paths);
    expect(slices[0].status).toBe('ready_to_merge');
  });

  it('turns a real merge conflict into a blocked result instead of throwing', async () => {
    repo = await createTempRepo();
    const paths = await setUpSingleSliceRun(repo.dir, 'run3');
    const slices = await readSlices(paths);
    slices[0].status = 'ready_to_merge';
    await writeSlices(paths, slices);

    // Create the slice branch with a change that conflicts with a later commit on main.
    const branch = await import('../../src/git/branch.js');
    const repository = await import('../../src/git/repository.js');
    await branch.checkoutNewBranchAt(repo.dir, slices[0].branch, 'main');
    await writeFile(`${repo.dir}/README.md`, 'from slice\n');
    await repository.commitAll(repo.dir, 'change readme on slice');
    await branch.checkoutExistingBranch(repo.dir, 'main');
    await writeFile(`${repo.dir}/README.md`, 'from main\n');
    await repository.commitAll(repo.dir, 'change readme on main');

    const AutoMergeStrategy = (await import('../../src/strategies/merge/auto.js'))
      .AutoMergeStrategy;
    const result = await runReconcilerPass({
      repoRoot: repo.dir,
      paths,
      baseBranch: 'main',
      provider: new FakeAgentProvider(async () => ({ success: true, output: 'unused' })),
      config: baseConfig,
      mergeStrategy: new AutoMergeStrategy(),
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('merge failed');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/orchestrator/reconcile.test.ts`
Expected: FAIL — `src/orchestrator/reconcile.ts` does not exist.

- [ ] **Step 8: Write `src/orchestrator/reconcile.ts`**

```ts
import type { JigConfig } from '../config/load-config.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import type { RunPaths } from '../state/run-paths.js';
import { readRunMeta, readSlices, writeSlices } from '../state/store.js';
import { advanceRun } from './advance.js';
import { runImplementStep } from './implement-step.js';
import { runReviewStep } from './review-step.js';

export interface ReconcilePassInput {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  provider: AgentProvider;
  config: JigConfig;
  mergeStrategy: MergeStrategy;
}

export interface ReconcilePassResult {
  blocked: boolean;
  reason?: string;
  complete: boolean;
}

export async function runReconcilerPass(input: ReconcilePassInput): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, provider, config, mergeStrategy } = input;
  const meta = await readRunMeta(paths);
  const slices = await readSlices(paths);
  const slice = slices.find((candidate) => candidate.id === meta.currentSliceId);

  if (!slice) {
    return {
      blocked: false,
      complete: slices.length > 0 && slices.every((s) => s.status === 'merged'),
    };
  }

  switch (slice.status) {
    case 'pending':
      await runImplementStep({ repoRoot, paths, slice, baseBranch, provider });
      break;
    case 'in_review':
      await runReviewStep({ paths, slice, provider, config });
      break;
    case 'ready_to_merge':
      // advanceRun persists slices/run-meta itself on success — it must not be
      // written again here with this function's now-stale in-memory `slices`,
      // or a just-recorded merge gets silently reverted to ready_to_merge.
      return runAdvance({ repoRoot, paths, baseBranch, mergeStrategy, sliceId: slice.id });
    case 'stuck':
      await writeSlices(paths, slices);
      return {
        blocked: true,
        reason: `slice "${slice.id}" is stuck — needs human intervention`,
        complete: false,
      };
    case 'implementing':
    case 'merged':
      break;
  }

  await writeSlices(paths, slices);
  return { blocked: false, complete: false };
}

async function runAdvance(input: {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  mergeStrategy: MergeStrategy;
  sliceId: string;
}): Promise<ReconcilePassResult> {
  const { repoRoot, paths, baseBranch, mergeStrategy, sliceId } = input;
  try {
    const advanceResult = await advanceRun({ repoRoot, paths, baseBranch, mergeStrategy });
    if (!advanceResult.advanced) {
      return {
        blocked: true,
        reason: `slice "${sliceId}" is ready_to_merge (manual mode)`,
        complete: false,
      };
    }
    return { blocked: false, complete: advanceResult.complete };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      blocked: true,
      reason: `merge failed for slice "${sliceId}": ${message}`,
      complete: false,
    };
  }
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/orchestrator/reconcile.test.ts`
Expected: PASS

- [ ] **Step 10: Lint and commit**

```bash
npm run lint
git add -A
git commit -m "feat: add local PR-create strategy and the unified reconciler pass"
```

---

### Task 16: CLI commands

**Files:**

- Modify: `src/cli/main.ts`
- Create: `src/cli/run-context.ts`
- Create: `src/cli/commands/prepare.ts`
- Create: `src/cli/commands/step.ts`
- Create: `src/cli/commands/merge.ts`
- Create: `src/cli/commands/create-pr.ts`
- Create: `src/cli/commands/status.ts`
- Create: `src/cli/commands/autopilot.ts`
- Test: `tests/cli/commands/step.test.ts`
- Test: `tests/cli/commands/autopilot.test.ts`

**Interfaces:**

- Consumes: `prepareRun` (Task 10); `runReconcilerPass`, `advanceRun` (Tasks 14–15); `loadRunState`, `readRunMeta`, `readSlices` (Task 6); `loadConfig` (Task 7); `ManualMergeStrategy`, `AutoMergeStrategy` (Task 14); `LocalPrCreateStrategy` (Task 15); `MarkdownFileInputSource` (Task 9).
- Produces: `buildCli(): Command` (extended, registers all eight v1 commands: `prepare`, `implement`, `review`, `merge`, `create-pr`, `status`, `autopilot`, `resume`); `runAutopilot(input: AutopilotInput): Promise<AutopilotResult>` where `AutopilotInput` mirrors `ReconcilePassInput` minus one-pass-only, and `AutopilotResult = { complete: boolean; blockedReason?: string; passes: number }` — loops `runReconcilerPass` until `complete` or `blocked`.

- [ ] **Step 1: Write `src/cli/run-context.ts`** (shared setup used by every command)

```ts
import { loadConfig, type JigConfig } from '../config/load-config.js';
import { getCurrentBranch } from '../git/branch.js';
import { AutoMergeStrategy } from '../strategies/merge/auto.js';
import { ManualMergeStrategy } from '../strategies/merge/manual.js';
import type { MergeStrategy } from '../strategies/merge/types.js';
import type { AgentProvider } from '../strategies/provider/types.js';
import { loadRunState, readRunMeta } from '../state/store.js';
import type { RunPaths } from '../state/run-paths.js';

export interface CliRunContext {
  repoRoot: string;
  paths: RunPaths;
  baseBranch: string;
  config: JigConfig;
  mergeStrategy: MergeStrategy;
}

export async function loadCliRunContext(repoRoot: string, runId: string): Promise<CliRunContext> {
  const paths = await loadRunState(repoRoot, runId);
  const meta = await readRunMeta(paths);
  const config = loadConfig(repoRoot);
  return {
    repoRoot,
    paths,
    baseBranch: meta.baseBranch,
    config,
    mergeStrategy:
      config.mergeMode === 'auto' ? new AutoMergeStrategy() : new ManualMergeStrategy(),
  };
}

export function selectProvider(): AgentProvider {
  // Task 17 replaces this with the real subprocess-backed provider selection.
  throw new Error('No real agent provider configured yet');
}

export { getCurrentBranch };
```

- [ ] **Step 2: Write `src/cli/commands/prepare.ts`**

```ts
import { Command } from 'commander';
import { prepareRun } from '../../orchestrator/prepare.js';
import { MarkdownFileInputSource } from '../../strategies/input-source/markdown-file.js';
import { selectProvider } from '../run-context.js';

export function registerPrepareCommand(program: Command): void {
  program
    .command('prepare')
    .requiredOption('--input <file>', 'path to a markdown request file')
    .action(async (opts: { input: string }) => {
      const meta = await prepareRun({
        repoRoot: process.cwd(),
        inputSource: new MarkdownFileInputSource(opts.input),
        provider: selectProvider(),
      });
      console.log(`Run ${meta.runId} prepared from ${opts.input}`);
    });
}
```

- [ ] **Step 3: Write `src/cli/commands/step.ts`** (implement / review share the same one-pass shape)

```ts
import { Command } from 'commander';
import { runReconcilerPass } from '../../orchestrator/reconcile.js';
import { loadCliRunContext, selectProvider } from '../run-context.js';

export function registerStepCommands(program: Command): void {
  for (const name of ['implement', 'review'] as const) {
    program
      .command(name)
      .requiredOption('--run <id>', 'run id')
      .action(async (opts: { run: string }) => {
        const context = await loadCliRunContext(process.cwd(), opts.run);
        const result = await runReconcilerPass({ ...context, provider: selectProvider() });
        if (result.blocked) {
          console.log(`Blocked: ${result.reason}`);
          return;
        }
        console.log(result.complete ? 'Run complete.' : 'Step complete.');
      });
  }
}
```

- [ ] **Step 4: Write `src/cli/commands/status.ts`**

```ts
import { Command } from 'commander';
import { loadRunState, readRunMeta, readSlices } from '../../state/store.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const paths = await loadRunState(process.cwd(), opts.run);
      const meta = await readRunMeta(paths);
      const slices = await readSlices(paths);
      console.log(
        `Run ${meta.runId} (base: ${meta.baseBranch}, current: ${meta.currentSliceId ?? '—'})`,
      );
      for (const slice of slices) {
        console.log(`  [${slice.status}] ${slice.id} — ${slice.title}`);
      }
    });
}
```

- [ ] **Step 5: Write `src/cli/commands/merge.ts` and `src/cli/commands/create-pr.ts`**

```ts
// src/cli/commands/merge.ts
import { Command } from 'commander';
import { advanceRun } from '../../orchestrator/advance.js';
import { AutoMergeStrategy } from '../../strategies/merge/auto.js';
import { loadCliRunContext } from '../run-context.js';

export function registerMergeCommand(program: Command): void {
  program
    .command('merge')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const context = await loadCliRunContext(process.cwd(), opts.run);
      const result = await advanceRun({ ...context, mergeStrategy: new AutoMergeStrategy() });
      console.log(
        result.advanced
          ? `Merged. Current slice is now: ${result.currentSliceId ?? '(run complete)'}`
          : `Nothing to merge yet for the current slice.`,
      );
    });
}
```

```ts
// src/cli/commands/create-pr.ts
import { Command } from 'commander';
import { LocalPrCreateStrategy } from '../../strategies/pr/local.js';
import { readRunMeta, readSlices } from '../../state/store.js';
import { loadCliRunContext } from '../run-context.js';

export function registerCreatePrCommand(program: Command): void {
  program
    .command('create-pr')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const context = await loadCliRunContext(process.cwd(), opts.run);
      const meta = await readRunMeta(context.paths);
      const slices = await readSlices(context.paths);
      const slice = slices.find((candidate) => candidate.id === meta.currentSliceId);
      if (!slice) {
        console.log('No current slice to create a PR description for.');
        return;
      }
      await new LocalPrCreateStrategy().create(context.paths, slice);
      console.log(`Wrote PR description for "${slice.id}" to the workspace.`);
    });
}
```

- [ ] **Step 6: Write the failing test for the step command's blocked-output behavior**

```ts
// tests/cli/commands/step.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// vi.mock calls are hoisted above imports by Vitest, so declaring them first
// is a style choice, not a requirement — but spying on named ESM exports
// directly (vi.spyOn(moduleNamespace, 'fn')) does NOT work reliably against
// compiled ESM output: the module under test's own import binding does not
// see the spy. vi.mock with a factory replaces the module in the resolver
// itself, which every importer (including step.ts) sees.
vi.mock('../../../src/orchestrator/reconcile.js', () => ({ runReconcilerPass: vi.fn() }));
vi.mock('../../../src/cli/run-context.js', () => ({
  loadCliRunContext: vi.fn(),
  selectProvider: vi.fn(),
}));

import { registerStepCommands } from '../../../src/cli/commands/step.js';
import { runReconcilerPass } from '../../../src/orchestrator/reconcile.js';
import { loadCliRunContext, selectProvider } from '../../../src/cli/run-context.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('implement/review commands', () => {
  it('prints the blocked reason when the reconciler pass is blocked', async () => {
    vi.mocked(loadCliRunContext).mockResolvedValue({
      repoRoot: '/tmp/repo',
      paths: {
        runId: 'r1',
        repoRoot: '/tmp/repo',
        stateDir: '/tmp/repo/.jig/r1/state',
        workspaceDir: '/tmp/repo/.jig/r1/workspace',
      },
      baseBranch: 'main',
      config: {
        mergeMode: 'manual',
        reviewCycleCap: 3,
        conflictResolveCap: 3,
        inputSource: 'markdown-file',
        providerCommand: 'claude',
      },
      mergeStrategy: { merge: vi.fn() },
    });
    vi.mocked(selectProvider).mockReturnValue({ run: vi.fn() });
    vi.mocked(runReconcilerPass).mockResolvedValue({
      blocked: true,
      reason: 'slice "s1" is stuck — needs human intervention',
      complete: false,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerStepCommands(program);
    await program.parseAsync(['node', 'jig', 'implement', '--run', 'r1']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('stuck'));
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/cli/commands/step.test.ts`
Expected: FAIL — `src/cli/commands/step.ts` does not exist yet as a module the test can spy against correctly, or the command isn't registered. (If it unexpectedly passes because the file from Step 3 already exists, proceed — Step 3 and this test were written together per TDD-for-CLI-wiring; the meaningful red/green check is Step 8 confirming the mocked path is exercised.)

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run tests/cli/commands/step.test.ts`
Expected: PASS

- [ ] **Step 9: Write `src/cli/commands/autopilot.ts`**

```ts
import { Command } from 'commander';
import { prepareRun } from '../../orchestrator/prepare.js';
import { runReconcilerPass, type ReconcilePassInput } from '../../orchestrator/reconcile.js';
import { MarkdownFileInputSource } from '../../strategies/input-source/markdown-file.js';
import { loadCliRunContext, selectProvider } from '../run-context.js';

export interface AutopilotResult {
  complete: boolean;
  blockedReason?: string;
  passes: number;
}

// A hard cap, not a tuning knob: prepareRun (Task 10) sets currentSliceId so
// the reconciler always has an actionable slice, and every non-blocked
// outcome moves a slice forward by one status. This guard exists purely so a
// future regression in that contract fails loudly with a clear error instead
// of hanging the process.
const MAX_RECONCILER_PASSES = 500;

export async function runAutopilot(
  input: Omit<ReconcilePassInput, 'provider'> & { provider: ReconcilePassInput['provider'] },
): Promise<AutopilotResult> {
  let passes = 0;
  while (passes < MAX_RECONCILER_PASSES) {
    passes += 1;
    const result = await runReconcilerPass(input);
    if (result.complete) return { complete: true, passes };
    if (result.blocked) return { complete: false, blockedReason: result.reason, passes };
  }
  throw new Error(
    `Autopilot made no determination after ${MAX_RECONCILER_PASSES} reconciler passes — this indicates a bug in the reconciler, not a slow run.`,
  );
}

export function registerAutopilotCommands(program: Command): void {
  program
    .command('autopilot')
    .requiredOption('--input <file>', 'path to a markdown request file')
    .action(async (opts: { input: string }) => {
      const repoRoot = process.cwd();
      const provider = selectProvider();
      const meta = await prepareRun({
        repoRoot,
        inputSource: new MarkdownFileInputSource(opts.input),
        provider,
      });
      const context = await loadCliRunContext(repoRoot, meta.runId);
      const result = await runAutopilot({ ...context, provider });
      console.log(
        result.complete
          ? `Run ${meta.runId} complete after ${result.passes} pass(es).`
          : `Run ${meta.runId} blocked after ${result.passes} pass(es): ${result.blockedReason}`,
      );
    });

  program
    .command('resume')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const repoRoot = process.cwd();
      const provider = selectProvider();
      const context = await loadCliRunContext(repoRoot, opts.run);
      const result = await runAutopilot({ ...context, provider });
      console.log(
        result.complete
          ? `Run ${opts.run} complete after ${result.passes} pass(es).`
          : `Run ${opts.run} blocked after ${result.passes} pass(es): ${result.blockedReason}`,
      );
    });
}
```

- [ ] **Step 10: Write the failing test for `runAutopilot`**

```ts
// tests/cli/commands/autopilot.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/orchestrator/reconcile.js', () => ({ runReconcilerPass: vi.fn() }));

import { runAutopilot } from '../../../src/cli/commands/autopilot.js';
import { runReconcilerPass } from '../../../src/orchestrator/reconcile.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runAutopilot', () => {
  it('loops the reconciler pass until complete', async () => {
    vi.mocked(runReconcilerPass)
      .mockResolvedValueOnce({ blocked: false, complete: false })
      .mockResolvedValueOnce({ blocked: false, complete: false })
      .mockResolvedValueOnce({ blocked: false, complete: true });

    const result = await runAutopilot({
      repoRoot: '/tmp/repo',
      paths: { runId: 'r1', repoRoot: '/tmp/repo', stateDir: '/x', workspaceDir: '/y' },
      baseBranch: 'main',
      provider: { run: vi.fn() },
      config: {
        mergeMode: 'auto',
        reviewCycleCap: 3,
        conflictResolveCap: 3,
        inputSource: 'markdown-file',
        providerCommand: 'claude',
      },
      mergeStrategy: { merge: vi.fn() },
    });

    expect(result.complete).toBe(true);
    expect(result.passes).toBe(3);
  });

  it('stops and reports the reason when a pass is blocked', async () => {
    vi.mocked(runReconcilerPass).mockResolvedValueOnce({
      blocked: true,
      reason: 'slice "s1" is stuck — needs human intervention',
      complete: false,
    });

    const result = await runAutopilot({
      repoRoot: '/tmp/repo',
      paths: { runId: 'r1', repoRoot: '/tmp/repo', stateDir: '/x', workspaceDir: '/y' },
      baseBranch: 'main',
      provider: { run: vi.fn() },
      config: {
        mergeMode: 'auto',
        reviewCycleCap: 3,
        conflictResolveCap: 3,
        inputSource: 'markdown-file',
        providerCommand: 'claude',
      },
      mergeStrategy: { merge: vi.fn() },
    });

    expect(result.complete).toBe(false);
    expect(result.blockedReason).toContain('stuck');
    expect(result.passes).toBe(1);
  });

  it('throws instead of looping forever if the reconciler never completes or blocks', async () => {
    vi.mocked(runReconcilerPass).mockResolvedValue({ blocked: false, complete: false });

    await expect(
      runAutopilot({
        repoRoot: '/tmp/repo',
        paths: { runId: 'r1', repoRoot: '/tmp/repo', stateDir: '/x', workspaceDir: '/y' },
        baseBranch: 'main',
        provider: { run: vi.fn() },
        config: {
          mergeMode: 'auto',
          reviewCycleCap: 3,
          conflictResolveCap: 3,
          inputSource: 'markdown-file',
          providerCommand: 'claude',
        },
        mergeStrategy: { merge: vi.fn() },
      }),
    ).rejects.toThrow(/reconciler passes/);
  });
});
```

- [ ] **Step 11: Run the test to verify it fails, then passes**

Run: `npx vitest run tests/cli/commands/autopilot.test.ts`
Expected: FAIL, then after Step 9's implementation exists: PASS.

- [ ] **Step 12: Wire every command into `buildCli`**

```ts
// src/cli/main.ts
#!/usr/bin/env node
import { Command } from 'commander';
import { registerPrepareCommand } from './commands/prepare.js';
import { registerStepCommands } from './commands/step.js';
import { registerMergeCommand } from './commands/merge.js';
import { registerCreatePrCommand } from './commands/create-pr.js';
import { registerStatusCommand } from './commands/status.js';
import { registerAutopilotCommands } from './commands/autopilot.js';

export function buildCli(): Command {
  const program = new Command();
  program.name('jig').description('Agentic SDLC pipeline orchestrator').version('0.1.0');
  registerPrepareCommand(program);
  registerStepCommands(program);
  registerMergeCommand(program);
  registerCreatePrCommand(program);
  registerStatusCommand(program);
  registerAutopilotCommands(program);
  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildCli().parse(process.argv);
}
```

- [ ] **Step 13: Run the full test suite**

Run: `npm test`
Expected: PASS (all tests from Tasks 1–16)

- [ ] **Step 14: Lint, build, and commit**

```bash
npm run lint
npm run build
git add -A
git commit -m "feat: wire prepare/implement/review/merge/create-pr/status/autopilot/resume CLI commands"
```

---

### Task 17: Real agent provider (agentic CLI subprocess wrapper)

**Files:**

- Create: `src/strategies/provider/agentic-cli.ts`
- Modify: `src/cli/run-context.ts` (replace `selectProvider` stub with the real selection)
- Test: `tests/strategies/provider/agentic-cli.test.ts`

**Interfaces:**

- Consumes: `AgentProvider`, `AgentRunInput`, `AgentRunResult` (Task 8); `JigConfig` (Task 7).
- Produces: `AgenticCliProvider` class implementing `AgentProvider`, constructed with `{ command: string; args?: string[]; timeoutMs?: number }`; spawns `command [...args, prompt]` headless via execa in `input.cwd`, captures stdout/stderr, writes a log, and maps exit code to `AgentRunResult.success`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/strategies/provider/agentic-cli.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgenticCliProvider } from '../../../src/strategies/provider/agentic-cli.js';

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('AgenticCliProvider', () => {
  it('reports success when the underlying command exits 0', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-provider-'));
    const script = path.join(dir, 'fake-agent.sh');
    await writeFile(script, '#!/bin/sh\necho "got: $@"\nexit 0\n');
    await chmod(script, 0o755);

    const provider = new AgenticCliProvider({ command: script });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('do the thing');
  });

  it('reports failure when the underlying command exits non-zero', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jig-provider-'));
    const script = path.join(dir, 'fake-agent.sh');
    await writeFile(script, '#!/bin/sh\necho "failing" 1>&2\nexit 1\n');
    await chmod(script, 0o755);

    const provider = new AgenticCliProvider({ command: script });
    const result = await provider.run({ cwd: dir, prompt: 'do the thing' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('failing');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/strategies/provider/agentic-cli.test.ts`
Expected: FAIL — `src/strategies/provider/agentic-cli.ts` does not exist.

- [ ] **Step 3: Write `src/strategies/provider/agentic-cli.ts`**

```ts
import { execa } from 'execa';
import type { AgentProvider, AgentRunInput, AgentRunResult } from './types.js';

export interface AgenticCliProviderOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export class AgenticCliProvider implements AgentProvider {
  constructor(private readonly options: AgenticCliProviderOptions) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { command, args = [], timeoutMs } = this.options;
    try {
      const result = await execa(command, [...args, input.prompt], {
        cwd: input.cwd,
        timeout: timeoutMs,
        reject: false,
      });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      return { success: result.exitCode === 0, output };
    } catch (error) {
      return { success: false, output: error instanceof Error ? error.message : String(error) };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/strategies/provider/agentic-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Wire it into `selectProvider`**

```ts
// src/cli/run-context.ts — replace the selectProvider stub
import { AgenticCliProvider } from '../strategies/provider/agentic-cli.js';
// ...
export function selectProvider(config: JigConfig): AgentProvider {
  return new AgenticCliProvider({
    command: config.providerCommand,
    args: ['-p', '--output-format', 'text'],
  });
}
```

Update every call site to pass a loaded `JigConfig` instead of calling the no-arg stub:

```ts
// src/cli/commands/prepare.ts — inside the action handler, before prepareRun is called
const config = loadConfig(process.cwd());
const meta = await prepareRun({
  repoRoot: process.cwd(),
  inputSource: new MarkdownFileInputSource(opts.input),
  provider: selectProvider(config),
});
```

(add `import { loadConfig } from '../../config/load-config.js';` to `prepare.ts`)

```ts
// src/cli/commands/step.ts — inside the action handler
const context = await loadCliRunContext(process.cwd(), opts.run);
const result = await runReconcilerPass({ ...context, provider: selectProvider(context.config) });
```

```ts
// src/cli/commands/autopilot.ts — both the `autopilot` and `resume` action handlers
const config = loadConfig(process.cwd()); // autopilot only: needed before loadCliRunContext exists
const provider = selectProvider(config);
```

For `resume`, `loadCliRunContext` already returns `config`, so use `selectProvider(context.config)` after loading the context instead, mirroring `step.ts`.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Lint, build, and commit**

```bash
npm run lint
npm run build
git add -A
git commit -m "feat: add real agentic-CLI subprocess provider and wire it into the CLI"
```

---

### Task 18: Mutation testing baseline and manual end-to-end verification notes

**Files:**

- Modify: `stryker.conf.json` (if the initial mutation run surfaces surviving mutants worth excluding — see Step 2)
- Create: `docs/superpowers/plans/2026-09-25-agentic-sdlc-orchestrator-e2e-verification.md`

**Interfaces:**

- Consumes: the full test suite from Tasks 1–17.
- Produces: a documented, opt-in manual verification procedure (not automated — the spec explicitly excludes a real-agent smoke test from CI).

- [ ] **Step 1: Run the mutation test suite**

Run: `npm run test:mutation`
Expected: completes and reports a mutation score. Review the HTML report (`reports/mutation/mutation.html`) for any surviving mutants that indicate a real gap in test coverage (not merely an equivalent mutant).

- [ ] **Step 2: Fix any coverage gap mutation testing surfaces**

For each surviving mutant that represents a real gap, add the missing test case to the relevant `tests/**/*.test.ts` file from the task that owns that source file, following the existing test patterns in that file. Re-run `npm run test:mutation` to confirm the mutant is now killed.

- [ ] **Step 3: Run secretlint**

Run: `npm run secretlint`
Expected: no findings. If a false positive appears in a test fixture, add a narrowly-scoped `.secretlintignore` entry for that exact path rather than disabling a rule globally.

- [ ] **Step 4: Write the manual end-to-end verification doc**

```markdown
# Manual End-to-End Verification

This procedure is intentionally NOT part of automated CI — it exercises a real
agentic CLI (cost, non-determinism), matching the spec's Testing Strategy.

1. In a scratch git repository with a trivial Node project and a passing
   `npm test`, write a one-paragraph markdown request file describing a small,
   real change (e.g. "add a GET /health endpoint returning 200").
2. Set `jig.config.json`: `{ "verifyCommand": "npm test", "mergeMode": "manual" }`.
3. Run `jig autopilot --input request.md` with `providerCommand` pointed at a
   real agentic CLI (e.g. `claude`).
4. Confirm: a run directory appears under `.jig/<runId>/`; `jig status --run
<runId>` shows at least one slice; the workspace worktree
   (`.jig/<runId>/workspace`) contains real code changes on a
   `jig/slice/<runId>/<sliceId>` branch; the command exits reporting either
   completion or a clear blocked reason (e.g. manual-mode `ready_to_merge`).
5. If blocked on `ready_to_merge`, manually merge the slice branch into `main`
   and run `jig resume --run <runId>`; confirm it detects the manual merge
   and either completes or advances to the next slice.
6. Record any prompt-quality issues (vague implement/review prompts, a
   reviewer that rubber-stamps) as follow-up work — this plan's prompts in
   `src/orchestrator/prompts.ts` and `review-step.ts` are a v1 starting point,
   not tuned.
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: establish mutation testing baseline and manual e2e verification procedure"
```
