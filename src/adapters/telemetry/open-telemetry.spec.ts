import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { sandboxTelemetryEnvironment, startTelemetry } from './open-telemetry.js';

describe('telemetry environment', () => {
  it('starts nothing unless an OTLP endpoint is configured', async () => {
    expect(await startTelemetry({ OTEL_SERVICE_NAME: faker.word.noun() })).toBeUndefined();
  });

  it.each(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'])(
    'starts tracing once %s is configured',
    async (variable) => {
      const telemetry = await startTelemetry({ [variable]: faker.internet.url() });

      expect(telemetry?.tracer).toBeDefined();
      await telemetry?.shutdown();
    },
  );

  it('forwards only OTEL_ variables into the sandbox and switches on Claude Code telemetry', () => {
    const endpoint = faker.internet.url();
    const serviceName = faker.word.noun();

    const forwarded = sandboxTelemetryEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_SERVICE_NAME: serviceName,
      CLAUDE_CODE_OAUTH_TOKEN: faker.string.alphanumeric(40),
    });

    expect(forwarded).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_SERVICE_NAME: serviceName,
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    });
  });

  it('forwards nothing when telemetry is off', () => {
    expect(sandboxTelemetryEnvironment({ OTEL_SERVICE_NAME: faker.word.noun() })).toEqual({});
  });
});
