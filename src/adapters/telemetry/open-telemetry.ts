import type { Tracer } from '@opentelemetry/api';

import type { TelemetrySettings } from '../../config/environment.js';

export interface Telemetry {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

/**
 * Starts the OpenTelemetry SDK with an OTLP/HTTP trace exporter, or nothing when telemetry is
 * off. Loaded lazily so a run without telemetry never pays for it.
 */
export async function startTelemetry(
  telemetry: TelemetrySettings | undefined,
): Promise<Telemetry | undefined> {
  if (!telemetry) return undefined;
  const [{ NodeSDK }, { OTLPTraceExporter }, api] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/api'),
  ]);
  const sdk = new NodeSDK({
    serviceName: telemetry.serviceName,
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
export function sandboxTelemetryEnvironment(
  telemetry: TelemetrySettings | undefined,
): Record<string, string> {
  if (!telemetry) return {};
  return { ...telemetry.forwarded, CLAUDE_CODE_ENABLE_TELEMETRY: '1' };
}
