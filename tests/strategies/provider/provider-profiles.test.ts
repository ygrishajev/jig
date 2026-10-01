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

    it('appends --model when a model is given', () => {
      const args = PROVIDER_PROFILES.claude.buildArgs('do the thing', 'claude-sonnet-4-5');

      expect(args).toEqual([
        '-p',
        'do the thing',
        '--output-format',
        'text',
        '--dangerously-skip-permissions',
        '--model',
        'claude-sonnet-4-5',
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
    afterEach(() => {
      delete process.env.OPENCODE_AUTH_JSON;
    });

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

    it('forwards OPENCODE_AUTH_JSON directly when set as a host env var (the CI path)', () => {
      expect(PROVIDER_PROFILES.opencode.envVarsFromHost).toEqual(['OPENCODE_AUTH_JSON']);
    });

    it('falls back to reading auth.json from disk when no env var is set (the local-dev path)', () => {
      const expectedHostPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

      expect(PROVIDER_PROFILES.opencode.hostEnvFileMounts).toEqual([
        { hostPath: expectedHostPath, envVarName: 'OPENCODE_AUTH_JSON' },
      ]);
    });

    it('does not throw when OPENCODE_AUTH_JSON is set, even without an auth.json file', () => {
      process.env.OPENCODE_AUTH_JSON = '{"openrouter":{"type":"api","key":"test"}}';

      expect(() => PROVIDER_PROFILES.opencode.assertCredentialsAvailable()).not.toThrow();
    });
  });
});
