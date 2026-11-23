import { Result } from 'better-result';
import { z } from 'zod';

import { describeIssues } from './describe-issues.js';
import { ConfigInvalid } from './errors.js';

/**
 * The process environment as jig reads it, parsed once by the CLI. Nothing else reads a variable
 * by name. The OpenTelemetry exporter still reads its own `OTEL_*` settings from the process;
 * this decides only whether tracing starts.
 */
export interface JigEnvironment {
  imageCache?: 'gha';
  codexAuthDirectory?: string;
  homeDirectory: string;
  xdgConfigHome?: string;
  telemetry?: TelemetrySettings;
  /** An agent credential by name; which names a step needs is the agent registry's to say. */
  credential(name: string): string | undefined;
}

/** Where traces go, and the `OTEL_*` variables passed on into the sandbox with them. */
export interface TelemetrySettings {
  serviceName: string;
  forwarded: Record<string, string>;
}

/**
 * An empty variable counts as unset, as it does for a shell's `${VAR:-default}`. The fallback home
 * directory stands in for an unset `HOME`; the edge that captures the environment supplies it.
 */
export function parseEnvironment(
  raw: NodeJS.ProcessEnv,
  fallbackHomeDirectory: string,
): Result<JigEnvironment, ConfigInvalid> {
  const variables = setVariables(raw);
  const parsed = knownVariablesSchema.safeParse(variables);
  if (!parsed.success) {
    return Result.err(
      new ConfigInvalid({
        message: `The environment is not valid — ${describeIssues(parsed.error)}`,
      }),
    );
  }
  const known = parsed.data;
  return Result.ok({
    imageCache: known.JIG_IMAGE_CACHE,
    codexAuthDirectory: known.JIG_CODEX_AUTH_DIR,
    homeDirectory: known.HOME ?? fallbackHomeDirectory,
    xdgConfigHome: known.XDG_CONFIG_HOME,
    telemetry:
      known.OTEL_EXPORTER_OTLP_ENDPOINT || known.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        ? { serviceName: known.OTEL_SERVICE_NAME ?? 'jig', forwarded: otelVariables(variables) }
        : undefined,
    credential: (name) => variables[name],
  });
}

function setVariables(raw: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

const knownVariablesSchema = z.object({
  JIG_IMAGE_CACHE: z.enum(['gha']).optional(),
  JIG_CODEX_AUTH_DIR: z.string().optional(),
  HOME: z.string().optional(),
  XDG_CONFIG_HOME: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
});

function otelVariables(variables: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => name.startsWith('OTEL_')));
}

/**
 * Adds credentials from outside the process environment, which still wins. Only credentials: a
 * file in the repository must not be able to set anything else jig reads.
 */
export function withCredentials(
  environment: JigEnvironment,
  credentials: Record<string, string>,
): JigEnvironment {
  const known = setVariables(credentials);
  return {
    ...environment,
    codexAuthDirectory: environment.codexAuthDirectory ?? known.JIG_CODEX_AUTH_DIR,
    credential: (name) => environment.credential(name) ?? known[name],
  };
}
