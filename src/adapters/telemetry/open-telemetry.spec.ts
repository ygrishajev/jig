import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { sandboxTelemetryEnvironment, startTelemetry } from './open-telemetry.js';

describe('telemetry', () => {
  it('starts nothing when telemetry is off', async () => {
    expect(await startTelemetry(undefined)).toBeUndefined();
  });

  it('starts tracing when telemetry is on', async () => {
    const telemetry = await startTelemetry({ serviceName: faker.word.noun(), forwarded: {} });

    expect(telemetry?.tracer).toBeDefined();
    await telemetry?.shutdown();
  });

  it('passes the OTEL_ variables into the sandbox and switches on Claude Code telemetry', () => {
    const forwarded = { OTEL_EXPORTER_OTLP_ENDPOINT: faker.internet.url() };

    expect(sandboxTelemetryEnvironment({ serviceName: faker.word.noun(), forwarded })).toEqual({
      ...forwarded,
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    });
  });

  it('passes nothing into the sandbox when telemetry is off', () => {
    expect(sandboxTelemetryEnvironment(undefined)).toEqual({});
  });
});
