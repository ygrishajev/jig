import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { agentNameSchema, resolvedModel } from './agent-policy.js';

describe('agent policy', () => {
  it.each(['claude', 'opencode', 'codex'] as const)('accepts %s as a provider', (provider) => {
    expect(agentNameSchema.parse(provider)).toBe(provider);
  });

  it.each(['toString', '__proto__', 'constructor', ''])('refuses %s as a provider', (provider) => {
    expect(agentNameSchema.safeParse(provider).success).toBe(false);
  });

  it('resolves the Claude fallback without assigning defaults to other providers', () => {
    expect(resolvedModel({ provider: 'claude' })).toBe('opus');
    expect(resolvedModel({ provider: 'opencode' })).toBeUndefined();
    expect(resolvedModel({ provider: 'codex' })).toBeUndefined();
  });

  it.each(['claude', 'opencode', 'codex'] as const)('keeps an explicit %s model', (provider) => {
    const model = faker.word.noun();
    expect(resolvedModel({ provider, model })).toBe(model);
  });
});
