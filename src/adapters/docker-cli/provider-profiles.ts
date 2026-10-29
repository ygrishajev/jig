import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostEnvFileMount } from './docker-cli.js';

export interface ProviderProfile {
  /** The binary name inside the sandbox image. */
  command: string;
  /**
   * Builds the full CLI args for one headless, permission-bypassed run.
   * `model` is passed for providers that accept an explicit model override
   * (currently opencode, via config's `opencodeModel`); a profile that
   * doesn't support one simply ignores it.
   */
  buildArgs(prompt: string, model?: string): string[];
  /** Host environment variable names to pass into the container, unchanged. */
  envVarsFromHost: string[];
  /** Host files (credentials) whose contents are passed into the container as an env var. */
  hostEnvFileMounts: HostEnvFileMount[];
  /**
   * Throws a clear, actionable error if this provider's credentials aren't
   * available on the host — checked before a container ever starts, so a
   * missing credential fails fast with a fix, not a cryptic in-container error.
   */
  assertCredentialsAvailable(): void;
}

const opencodeAuthPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');

export const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  claude: {
    command: 'claude',
    buildArgs: (prompt, model) => [
      '-p',
      prompt,
      '--output-format',
      'text',
      // Bypasses claude's interactive tool-use approval gate — required for
      // any unattended file write / bash call in headless mode, since
      // there's no TTY to approve prompts against. Only ever used here,
      // inside the sandbox container — never on the bare host.
      '--dangerously-skip-permissions',
      ...(model ? ['--model', model] : []),
    ],
    envVarsFromHost: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    hostEnvFileMounts: [],
    assertCredentialsAvailable(): void {
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
        throw new Error(
          'No claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`' +
            ' on your host once) or ANTHROPIC_API_KEY in your environment before running sdlc.',
        );
      }
    },
  },
  opencode: {
    command: 'opencode',
    buildArgs: (prompt, model) => [
      'run',
      prompt,
      '--format',
      'json',
      // Auto-approves permissions not explicitly denied — opencode's
      // equivalent of claude's --dangerously-skip-permissions. Same
      // reasoning: only ever used here, inside the sandbox container.
      '--auto',
      // Without this, a fresh sandbox container (no stored model
      // preference) falls back to opencode's own default, which may not
      // support tool use on the configured OpenRouter account.
      ...(model ? ['--model', model] : []),
    ],
    // CI's natural path: a secret goes straight into OPENCODE_AUTH_JSON,
    // same as claude's tokens above — no file, nothing touches the host's
    // disk. (docker-cli.ts skips the file fallback below when this is set,
    // so CI never needs `opencode auth login`'s on-disk output at all.)
    envVarsFromHost: ['OPENCODE_AUTH_JSON'],
    // Local-dev fallback only, for when there's no env var to hand: reads
    // back what `opencode auth login` already wrote to disk. $HOME inside
    // the sandbox is a tmpfs with nothing backing it on the host (see
    // SANDBOX_HOME in docker-cli.ts), so this can't be a bind mount either
    // way — the entrypoint baked into the sandbox image writes the value to
    // the path opencode actually reads, once the container itself owns
    // $HOME.
    hostEnvFileMounts: [{ hostPath: opencodeAuthPath, envVarName: 'OPENCODE_AUTH_JSON' }],
    assertCredentialsAvailable(): void {
      if (!process.env.OPENCODE_AUTH_JSON && !existsSync(opencodeAuthPath)) {
        throw new Error(
          'No opencode credentials found. Set OPENCODE_AUTH_JSON in your environment (e.g. a CI' +
            ` secret), or run \`opencode auth login\` on your host once — it writes to` +
            ` ${opencodeAuthPath}, which sdlc falls back to reading when the env var isn't set.`,
        );
      }
    },
  },
};
