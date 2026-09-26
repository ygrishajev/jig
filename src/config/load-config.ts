import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  mergeMode: z.enum(['manual', 'auto']).default('manual'),
  reviewCycleCap: z.number().int().positive().default(3),
  conflictResolveCap: z.number().int().positive().default(3),
  verifyCommand: z.string().optional(),
  inputSource: z.enum(['markdown-file']).default('markdown-file'),
  // Must stay in sync with the keys of PROVIDER_PROFILES in
  // src/strategies/provider/provider-profiles.ts — not imported from here to
  // keep config a lower-level module than the strategies built on top of it.
  providerCommand: z.enum(['claude', 'opencode']).default('claude'),
  // Overrides providerCommand for the implement step only (prepare's
  // planning steps and review always use providerCommand). Falls back to
  // providerCommand when unset — most setups only ever need one provider.
  implementProviderCommand: z.enum(['claude', 'opencode']).optional(),
  // Explicit "provider/model" passed to opencode via -m. Left unset, a fresh
  // sandbox container has no stored model preference and opencode falls back
  // to its own default, which may not support tool use on your OpenRouter
  // account — set this to whatever you use successfully in interactive mode.
  opencodeModel: z.string().optional(),
});
export type SdlcConfig = z.infer<typeof configSchema>;

export function loadConfig(repoRoot: string): SdlcConfig {
  const configPath = path.join(repoRoot, 'sdlc.config.json');
  if (!existsSync(configPath)) return configSchema.parse({});
  return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
}
