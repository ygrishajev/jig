import assert from 'node:assert/strict';

import type { AgentChoice } from '../../src/adapters/sandcastle/agents.js';
import { byRole } from '../../src/domain/agent-role.js';

export const FEATURE_TEST_COMMAND = 'node --test --test-reporter=tap summary.test.mjs';

export function e2eAgents(environment: NodeJS.ProcessEnv) {
  const agents: AgentChoice[] = [];
  if (environment.CLAUDE_CODE_OAUTH_TOKEN || environment.ANTHROPIC_API_KEY) {
    agents.push({ provider: 'claude', model: environment.SDLC_E2E_CLAUDE_MODEL ?? 'haiku' });
  }
  if (environment.OPENROUTER_API_KEY) {
    const model = environment.SDLC_E2E_OPENROUTER_MODEL ?? environment.OPENCODE_MODEL;
    assert(
      model?.startsWith('openrouter/'),
      'Set SDLC_E2E_OPENROUTER_MODEL to openrouter/<model>.',
    );
    agents.push({ provider: 'opencode', model });
  }
  if (environment.SDLC_CODEX_AUTH_DIR) {
    assert(
      environment.SDLC_E2E_CODEX_MODEL,
      'Set SDLC_E2E_CODEX_MODEL for the Codex subscription.',
    );
    agents.push({ provider: 'codex', model: environment.SDLC_E2E_CODEX_MODEL });
  }
  assert(agents.length, 'Provide a Claude, OpenRouter, or Codex subscription credential.');
  let index = 0;
  return byRole(() => agents[index++ % agents.length]);
}
