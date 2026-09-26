import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_PROFILES } from '../../../src/strategies/provider/provider-profiles.js';

describe('PROVIDER_PROFILES', () => {
  describe('claude', () => {
    afterEach(() => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('builds args with the prompt after -p and includes the permission-bypass flag', () => {
      const args = PROVIDER_PROFILES.claude.buildArgs('do the thing');

      expect(args).toEqual([
        '-p',
        'do the thing',
        '--output-format',
        'text',
        '--dangerously-skip-permissions',
      ]);
    });

    it('throws when neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set', () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;

      expect(() => PROVIDER_PROFILES.claude.assertCredentialsAvailable()).toThrow(
        /claude setup-token/,
      );
    });

    it('does not throw when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

      expect(() => PROVIDER_PROFILES.claude.assertCredentialsAvailable()).not.toThrow();
    });

    it('does not throw when only ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      expect(() => PROVIDER_PROFILES.claude.assertCredentialsAvailable()).not.toThrow();
    });
  });

  describe('opencode', () => {
    it('builds args with the prompt placed right after the run subcommand', () => {
      const args = PROVIDER_PROFILES.opencode.buildArgs('do the thing');

      expect(args).toEqual(['run', 'do the thing', '--format', 'json', '--auto']);
    });

    it('appends --model when a model is given', () => {
      const args = PROVIDER_PROFILES.opencode.buildArgs('do the thing', 'openrouter/some-model');

      expect(args).toEqual([
        'run',
        'do the thing',
        '--format',
        'json',
        '--auto',
        '--model',
        'openrouter/some-model',
      ]);
    });

    it('mounts the host auth.json read-only into the container home directory', () => {
      const expectedHostPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

      expect(PROVIDER_PROFILES.opencode.hostFileMounts).toEqual([
        { hostPath: expectedHostPath, containerPath: '/home/node/.local/share/opencode/auth.json' },
      ]);
    });

    it('uses no host environment variables (credentials are file-based)', () => {
      expect(PROVIDER_PROFILES.opencode.envVarsFromHost).toEqual([]);
    });
  });
});
