import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type { AgentChoice } from '../../src/adapters/sandcastle/agents.js';
import { byRole } from '../../src/domain/agent-role.js';

const codexLoginSchema = z.object({
  tokens: z.object({
    access_token: z.string().min(1),
    id_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1),
  }),
});

export function e2eAgents(environment: NodeJS.ProcessEnv) {
  const agents: AgentChoice[] = [];
  if (environment.CLAUDE_CODE_OAUTH_TOKEN || environment.ANTHROPIC_API_KEY) {
    agents.push({ provider: 'claude', model: environment.JIG_E2E_CLAUDE_MODEL ?? 'haiku' });
  }
  if (environment.OPENROUTER_API_KEY) {
    const model = environment.JIG_E2E_OPENROUTER_MODEL ?? environment.OPENCODE_MODEL;
    assert(model?.startsWith('openrouter/'), 'Set JIG_E2E_OPENROUTER_MODEL to openrouter/<model>.');
    agents.push({ provider: 'opencode', model });
  }
  if (environment.JIG_CODEX_AUTH_DIR) {
    assert(environment.JIG_E2E_CODEX_MODEL, 'Set JIG_E2E_CODEX_MODEL for the Codex subscription.');
    agents.push({ provider: 'codex', model: environment.JIG_E2E_CODEX_MODEL });
  }
  assert(agents.length, 'Provide a Claude, OpenRouter, or Codex subscription credential.');
  let index = 0;
  return byRole(() => agents[index++ % agents.length]);
}

/**
 * Points `JIG_CODEX_AUTH_DIR` at the operator's own Codex login (`$CODEX_HOME` or `~/.codex`)
 * when none is set and that login is a complete subscription one, so Codex joins the agents
 * without extra setup.
 */
export async function withCodexSubscription(environment: NodeJS.ProcessEnv) {
  if (environment.JIG_CODEX_AUTH_DIR) return environment;
  const home = environment.CODEX_HOME || path.join(homedir(), '.codex');
  const login = await readCodexLogin(home);
  return codexLoginSchema.safeParse(login).success
    ? { ...environment, JIG_CODEX_AUTH_DIR: home }
    : environment;
}

async function readCodexLogin(home: string): Promise<unknown> {
  const text = await readFile(path.join(home, 'auth.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new Error('Cannot read the existing Codex subscription login.');
    },
  );
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The existing Codex subscription login is not valid JSON.');
  }
}
