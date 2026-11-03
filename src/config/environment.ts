import { z } from 'zod';

import { ConfigInvalid } from '../domain/errors.js';

/**
 * The process environment as jig reads it, parsed once by the CLI. Nothing else reads a variable
 * by name. The OpenTelemetry exporter still reads its own `OTEL_*` settings from the process;
 * this decides only whether tracing starts.
 */
export interface JigEnvironment {
  imageCache?: 'gha';
  codexAuthDirectory?: string;
  telemetry?: TelemetrySettings;
  /** An agent credential by name; which names a step needs is the agent registry's to say. */
  credential(name: string): string | undefined;
}

/** Where traces go, and the `OTEL_*` variables passed on into the sandbox with them. */
export interface TelemetrySettings {
  serviceName: string;
  forwarded: Record<string, string>;
}

/** An empty variable counts as unset, as it does for a shell's `${VAR:-default}`. */
export function parseEnvironment(raw: NodeJS.ProcessEnv): JigEnvironment {
  const variables = setVariables(raw);
  const parsed = knownVariablesSchema.safeParse(variables);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigInvalid(`The environment is not valid — ${problems.join('; ')}`);
  }
  const known = parsed.data;
  return {
    imageCache: known.JIG_IMAGE_CACHE,
    codexAuthDirectory: known.JIG_CODEX_AUTH_DIR,
    telemetry:
      known.OTEL_EXPORTER_OTLP_ENDPOINT || known.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        ? { serviceName: known.OTEL_SERVICE_NAME ?? 'jig', forwarded: otelVariables(variables) }
        : undefined,
    credential: (name) => variables[name],
  };
}

function setVariables(raw: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

const knownVariablesSchema = z.object({
  JIG_IMAGE_CACHE: z.enum(['gha']).optional(),
  JIG_CODEX_AUTH_DIR: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
});

function otelVariables(variables: Record<string, string>) {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => name.startsWith('OTEL_')));
}
