import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { sandboxTelemetryEnvironment, telemetryEnabled } from './open-telemetry.js';

describe('telemetry environment', () => {
  it('is off unless an OTLP endpoint is configured', () => {
    expect(telemetryEnabled({})).toBe(false);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: faker.internet.url() })).toBe(true);
  });

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
