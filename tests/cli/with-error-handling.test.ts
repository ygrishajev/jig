import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withErrorHandling } from '../../src/cli/with-error-handling.js';

describe('withErrorHandling', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('does not re-throw and sets a non-zero exit code when the handler rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withErrorHandling(async () => {
      throw new Error('run "doesnotexist" not found');
    });

    await expect(handler()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('run "doesnotexist" not found');
  });

  it('prints a stringified value when a non-Error is thrown', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withErrorHandling(async () => {
      throw 'plain string failure';
    });

    await expect(handler()).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('plain string failure');
  });

  it('passes through arguments and leaves the exit code untouched on success', async () => {
    const handler = withErrorHandling(async (opts: { run: string }) => {
      expect(opts.run).toBe('r1');
    });

    await expect(handler({ run: 'r1' })).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });
});
