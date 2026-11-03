import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { ConfigInvalid } from '../domain/errors.js';
import { parseEnvironment } from './environment.js';

describe('parseEnvironment', () => {
  it('reads the image cache and the Codex auth directory', () => {
    const directory = faker.system.directoryPath();

    const environment = parseEnvironment({ JIG_IMAGE_CACHE: 'gha', JIG_CODEX_AUTH_DIR: directory });

    expect(environment).toMatchObject({ imageCache: 'gha', codexAuthDirectory: directory });
  });

  it.each(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'])(
    'turns telemetry on once %s is set, forwarding only OTEL_ variables',
    (endpointVariable) => {
      const endpoint = faker.internet.url();
      const serviceName = faker.word.noun();

      const { telemetry } = parseEnvironment({
        [endpointVariable]: endpoint,
        OTEL_SERVICE_NAME: serviceName,
        CLAUDE_CODE_OAUTH_TOKEN: faker.string.alphanumeric(40),
      });

      expect(telemetry).toEqual({
        serviceName,
        forwarded: { [endpointVariable]: endpoint, OTEL_SERVICE_NAME: serviceName },
      });
    },
  );

  it('leaves telemetry off without an endpoint, and names the service jig by default', () => {
    const endpoint = faker.internet.url();

    expect(parseEnvironment({ OTEL_SERVICE_NAME: faker.word.noun() }).telemetry).toBeUndefined();
    expect(parseEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }).telemetry?.serviceName).toBe(
      'jig',
    );
  });

  it('looks up a credential by name and treats an empty variable as unset', () => {
    const key = faker.string.alphanumeric(40);

    const environment = parseEnvironment({ OPENROUTER_API_KEY: key, ANTHROPIC_API_KEY: '' });

    expect(environment.credential('OPENROUTER_API_KEY')).toBe(key);
    expect(environment.credential('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(parseEnvironment({ JIG_IMAGE_CACHE: '' }).imageCache).toBeUndefined();
  });

  it.each([
    ['JIG_IMAGE_CACHE', faker.word.noun()],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', faker.word.noun()],
  ])('refuses %s set to a value jig cannot use, naming the variable', (variable, value) => {
    expect(() => parseEnvironment({ [variable]: value })).toThrow(ConfigInvalid);
    expect(() => parseEnvironment({ [variable]: value })).toThrow(variable);
  });
});
