import type { Tracer } from '@opentelemetry/api';

export interface Telemetry {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

/** Whether traces should be exported at all; the SDK is only loaded when they should. */
export function telemetryEnabled(environment: NodeJS.ProcessEnv) {
  return Boolean(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT || environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  );
}

/**
 * Starts the OpenTelemetry SDK with an OTLP/HTTP trace exporter, configured from the standard
 * `OTEL_*` environment variables. Loaded lazily so a run without telemetry never pays for it.
 */
export async function startTelemetry(environment: NodeJS.ProcessEnv): Promise<Telemetry> {
  const [{ NodeSDK }, { OTLPTraceExporter }, api] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/api'),
  ]);
  const sdk = new NodeSDK({
    serviceName: environment.OTEL_SERVICE_NAME ?? 'jig',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [],
  });
  sdk.start();
  return { tracer: api.trace.getTracer('jig'), shutdown: () => sdk.shutdown() };
}

/**
 * The `OTEL_*` variables passed into the sandbox, plus the switch that makes Claude Code export
 * its own telemetry to the same collector.
 */
export function sandboxTelemetryEnvironment(environment: NodeJS.ProcessEnv) {
  if (!telemetryEnabled(environment)) return {};
  const forwarded = Object.entries(environment).filter(
    (entry): entry is [string, string] => entry[0].startsWith('OTEL_') && entry[1] !== undefined,
  );
  return { ...Object.fromEntries(forwarded), CLAUDE_CODE_ENABLE_TELEMETRY: '1' };
}
