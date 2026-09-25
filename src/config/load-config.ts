import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  mergeMode: z.enum(['manual', 'auto']).default('manual'),
  reviewCycleCap: z.number().int().positive().default(3),
  conflictResolveCap: z.number().int().positive().default(3),
  verifyCommand: z.string().optional(),
  inputSource: z.enum(['markdown-file']).default('markdown-file'),
  providerCommand: z.string().default('claude'),
});
export type SdlcConfig = z.infer<typeof configSchema>;

export function loadConfig(repoRoot: string): SdlcConfig {
  const configPath = path.join(repoRoot, 'sdlc.config.json');
  if (!existsSync(configPath)) return configSchema.parse({});
  return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
}
