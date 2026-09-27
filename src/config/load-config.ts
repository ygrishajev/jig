import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const stepConfigSchema = z.object({
  provider: z.enum(['claude', 'opencode']),
  model: z.string().optional(),
});
export type StepConfig = z.infer<typeof stepConfigSchema>;
export type StepName = 'planner' | 'implementer' | 'reviewer';

// .strict() rejects unknown top-level keys — a typo like `implementer` vs
// `implement` must fail loudly at load time, not silently fall back to the
// default while a run uses the wrong provider.
const configSchema = z
  .object({
    mergeMode: z.enum(['manual', 'auto']).default('manual'),
    reviewCycleCap: z.number().int().positive().default(3),
    conflictResolveCap: z.number().int().positive().default(3),
    verifyCommand: z.string().optional(),
    inputSource: z.enum(['markdown-file']).default('markdown-file'),
    // 'repo' (default): commits behave exactly as the repository is configured,
    // including GPG signing. 'skip': sdlc disables signing in its slice
    // worktrees — needed when the repo signs commits through an agent that is
    // unreachable from the sandbox container (e.g. 1Password). The operator's
    // own repo and merges are never touched in either mode.
    commitSigning: z.enum(['repo', 'skip']).default('repo'),
    // Per-step agent configuration. Provider names must stay in sync with the
    // keys of PROVIDER_PROFILES in src/strategies/provider/provider-profiles.ts
    // — not imported from here to keep config a lower-level module than the
    // strategies built on top of it. `model` is passed to the provider CLI via
    // its model flag (e.g. opencode's --model); unset means the CLI's own
    // default.
    planner: stepConfigSchema.default({ provider: 'claude' }),
    implementer: stepConfigSchema.default({ provider: 'claude' }),
    reviewer: stepConfigSchema.default({ provider: 'claude' }),
  })
  .strict();
export type SdlcConfig = z.infer<typeof configSchema>;

export function loadConfig(repoRoot: string): SdlcConfig {
  const configPath = path.join(repoRoot, 'sdlc.config.json');
  if (!existsSync(configPath)) return configSchema.parse({});
  return configSchema.parse(JSON.parse(readFileSync(configPath, 'utf-8')));
}
