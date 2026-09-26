import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostFileMount } from './docker-cli.js';

export interface ProviderProfile {
  /** The binary name inside the sandbox image. */
  command: string;
  /** Builds the full CLI args for one headless, permission-bypassed run. */
  buildArgs(prompt: string): string[];
  /** Host environment variable names to pass into the container, unchanged. */
  envVarsFromHost: string[];
  /** Host files (credentials) to bind-mount read-only into the container. */
  hostFileMounts: HostFileMount[];
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
    buildArgs: (prompt) => [
      '-p',
      prompt,
      '--output-format',
      'text',
      // Bypasses claude's interactive tool-use approval gate — required for
      // any unattended file write / bash call in headless mode, since
      // there's no TTY to approve prompts against. Only ever used here,
      // inside the sandbox container — never on the bare host.
      '--dangerously-skip-permissions',
    ],
    envVarsFromHost: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    hostFileMounts: [],
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
    buildArgs: (prompt) => [
      'run',
      prompt,
      '--format',
      'json',
      // Auto-approves permissions not explicitly denied — opencode's
      // equivalent of claude's --dangerously-skip-permissions. Same
      // reasoning: only ever used here, inside the sandbox container.
      '--auto',
    ],
    envVarsFromHost: [],
    hostFileMounts: [
      {
        hostPath: opencodeAuthPath,
        // The sandbox runs as node:22-slim's built-in `node` user (see the
        // Dockerfile), whose $HOME is /home/node.
        containerPath: '/home/node/.local/share/opencode/auth.json',
      },
    ],
    assertCredentialsAvailable(): void {
      if (!existsSync(opencodeAuthPath)) {
        throw new Error(
          `No opencode credentials found at ${opencodeAuthPath}. Run \`opencode auth login\`` +
            ' on your host once before running sdlc.',
        );
      }
    },
  },
};
