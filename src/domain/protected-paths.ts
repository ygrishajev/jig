import picomatch from 'picomatch';

/** A file the run branch changed, and how — a rename reports its new path. */
export interface ChangedFile {
  path: string;
  kind: ChangeKind;
}

/** How a file changed, as the branch's diff reports it. */
export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** The changes among `changes` that touch a protected path. */
export function protectedChanges(changes: readonly ChangedFile[]): ChangedFile[] {
  return changes.filter(({ path, kind }) =>
    protectedMatchers.some(
      ({ flaggedWhen, isMatch }) =>
        isMatch(path) && (flaggedWhen === 'changed' || kind !== 'added'),
    ),
  );
}

/**
 * The paths a slice may not quietly weaken: touching the tests that already exist, or what
 * decides what gets checked, is flagged for review. A `notAdded` pattern welcomes a new file and
 * flags one that was already there; a `changed` pattern flags the file however it changed.
 */
export const protectedPathPatterns = [
  { pattern: '**/*.spec.*', flaggedWhen: 'notAdded' },
  { pattern: '**/*.test.*', flaggedWhen: 'notAdded' },
  { pattern: '**/test/**', flaggedWhen: 'notAdded' },
  { pattern: '**/tests/**', flaggedWhen: 'notAdded' },
  { pattern: '**/__tests__/**', flaggedWhen: 'notAdded' },
  { pattern: '**/*.snap', flaggedWhen: 'notAdded' },
  { pattern: '**/__snapshots__/**', flaggedWhen: 'notAdded' },
  { pattern: '**/package.json', flaggedWhen: 'changed' },
  { pattern: '**/.eslintrc*', flaggedWhen: 'changed' },
  { pattern: '**/eslint.config.*', flaggedWhen: 'changed' },
  { pattern: '**/.prettierrc*', flaggedWhen: 'changed' },
  { pattern: '**/prettier.config.*', flaggedWhen: 'changed' },
  { pattern: '**/tsconfig*.json', flaggedWhen: 'changed' },
  { pattern: '**/biome.json*', flaggedWhen: 'changed' },
  { pattern: '**/vitest.*', flaggedWhen: 'changed' },
  { pattern: '**/jest.config.*', flaggedWhen: 'changed' },
  { pattern: '**/stryker.conf.*', flaggedWhen: 'changed' },
  { pattern: '.github/workflows/**', flaggedWhen: 'changed' },
  { pattern: '.husky/**', flaggedWhen: 'changed' },
] as const;

const protectedMatchers = protectedPathPatterns.map(({ pattern, flaggedWhen }) => ({
  flaggedWhen,
  isMatch: picomatch(pattern, { dot: true }),
}));
