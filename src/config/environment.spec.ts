import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { parseEnvironment, withCredentials } from './environment.js';

describe('parseEnvironment', () => {
  it('reads the image cache and the Codex auth directory', () => {
    const directory = faker.system.directoryPath();

    const environment = unwrap(
      parseEnvironment(
        { JIG_IMAGE_CACHE: 'gha', JIG_CODEX_AUTH_DIR: directory },
        faker.system.directoryPath(),
      ),
    );

    expect(environment).toMatchObject({ imageCache: 'gha', codexAuthDirectory: directory });
  });

  it('leaves every optional setting unset when no variable is given', () => {
    const fallbackHomeDirectory = faker.system.directoryPath();

    const environment = unwrap(parseEnvironment({}, fallbackHomeDirectory));

    expect(environment).toMatchObject({
      imageCache: undefined,
      codexAuthDirectory: undefined,
      homeDirectory: fallbackHomeDirectory,
      xdgConfigHome: undefined,
      telemetry: undefined,
    });
  });

  it('takes the home directory from HOME over the fallback it was given', () => {
    const homeDirectory = faker.system.directoryPath();

    const environment = unwrap(
      parseEnvironment({ HOME: homeDirectory }, faker.system.directoryPath()),
    );

    expect(environment.homeDirectory).toBe(homeDirectory);
  });

  it.each([{}, { HOME: '' }])(
    'falls back to the home directory it was given when HOME is unset in %j',
    (variables) => {
      const fallbackHomeDirectory = faker.system.directoryPath();

      const environment = unwrap(parseEnvironment(variables, fallbackHomeDirectory));

      expect(environment.homeDirectory).toBe(fallbackHomeDirectory);
    },
  );

  it('reads the XDG config home', () => {
    const xdgConfigHome = faker.system.directoryPath();

    const environment = unwrap(
      parseEnvironment({ XDG_CONFIG_HOME: xdgConfigHome }, faker.system.directoryPath()),
    );

    expect(environment.xdgConfigHome).toBe(xdgConfigHome);
  });

  it('leaves the XDG config home unset when XDG_CONFIG_HOME is empty', () => {
    const environment = unwrap(
      parseEnvironment({ XDG_CONFIG_HOME: '' }, faker.system.directoryPath()),
    );

    expect(environment.xdgConfigHome).toBeUndefined();
  });

  it.each(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'])(
    'turns telemetry on once %s is set, forwarding only OTEL_ variables',
    (endpointVariable) => {
      const endpoint = faker.internet.url();
      const serviceName = faker.word.noun();

      const { telemetry } = unwrap(
        parseEnvironment(
          {
            [endpointVariable]: endpoint,
            OTEL_SERVICE_NAME: serviceName,
            OTEL_RESOURCE_ATTRIBUTES: '',
            CLAUDE_CODE_OAUTH_TOKEN: faker.string.alphanumeric(40),
          },
          faker.system.directoryPath(),
        ),
      );

      expect(telemetry).toEqual({
        serviceName,
        forwarded: { [endpointVariable]: endpoint, OTEL_SERVICE_NAME: serviceName },
      });
    },
  );

  it('leaves telemetry off without an endpoint, and names the service jig by default', () => {
    const endpoint = faker.internet.url();

    const withoutEndpoint = unwrap(
      parseEnvironment({ OTEL_SERVICE_NAME: faker.word.noun() }, faker.system.directoryPath()),
    );
    const withEndpoint = unwrap(
      parseEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }, faker.system.directoryPath()),
    );

    expect(withoutEndpoint.telemetry).toBeUndefined();
    expect(withEndpoint.telemetry?.serviceName).toBe('jig');
  });

  it('looks up a credential by name and treats an empty variable as unset', () => {
    const key = faker.string.alphanumeric(40);

    const environment = unwrap(
      parseEnvironment(
        { OPENROUTER_API_KEY: key, ANTHROPIC_API_KEY: '' },
        faker.system.directoryPath(),
      ),
    );

    expect(environment.credential('OPENROUTER_API_KEY')).toBe(key);
    expect(environment.credential('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(
      unwrap(parseEnvironment({ JIG_IMAGE_CACHE: '' }, faker.system.directoryPath())).imageCache,
    ).toBeUndefined();
  });

  it.each([
    ['JIG_IMAGE_CACHE', faker.word.noun()],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', faker.word.noun()],
    ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', faker.word.noun()],
  ])('refuses %s set to a value jig cannot use, naming the variable', (variable, value) => {
    const result = parseEnvironment({ [variable]: value }, faker.system.directoryPath());

    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toContain(variable);
  });
});

describe('withCredentials', () => {
  it('keeps a credential set in the environment over the saved one', () => {
    const fromEnvironment = faker.string.alphanumeric(40);
    const environment = unwrap(
      parseEnvironment({ ANTHROPIC_API_KEY: fromEnvironment }, faker.system.directoryPath()),
    );

    const combined = withCredentials(environment, {
      ANTHROPIC_API_KEY: faker.string.alphanumeric(40),
    });

    expect(combined.credential('ANTHROPIC_API_KEY')).toBe(fromEnvironment);
  });

  it('takes a saved credential the environment leaves unset or empty', () => {
    const saved = faker.string.alphanumeric(40);
    const savedCodexAuthDirectory = faker.system.directoryPath();
    const environment = unwrap(
      parseEnvironment({ ANTHROPIC_API_KEY: '' }, faker.system.directoryPath()),
    );

    const combined = withCredentials(environment, {
      ANTHROPIC_API_KEY: saved,
      JIG_CODEX_AUTH_DIR: savedCodexAuthDirectory,
      OPENROUTER_API_KEY: '',
    });

    expect(combined.credential('ANTHROPIC_API_KEY')).toBe(saved);
    expect(combined.codexAuthDirectory).toBe(savedCodexAuthDirectory);
    expect(combined.credential('OPENROUTER_API_KEY')).toBeUndefined();
  });

  it('keeps the Codex auth directory set in the environment over the saved one', () => {
    const fromEnvironment = faker.system.directoryPath();
    const environment = unwrap(
      parseEnvironment({ JIG_CODEX_AUTH_DIR: fromEnvironment }, faker.system.directoryPath()),
    );

    const combined = withCredentials(environment, {
      JIG_CODEX_AUTH_DIR: faker.system.directoryPath(),
    });

    expect(combined.codexAuthDirectory).toBe(fromEnvironment);
  });

  it('takes nothing but credentials from the saved file', () => {
    const fallbackHomeDirectory = faker.system.directoryPath();
    const environment = unwrap(parseEnvironment({}, fallbackHomeDirectory));

    const combined = withCredentials(environment, {
      JIG_IMAGE_CACHE: 'gha',
      HOME: faker.system.directoryPath(),
      XDG_CONFIG_HOME: faker.system.directoryPath(),
      OTEL_EXPORTER_OTLP_ENDPOINT: faker.internet.url(),
    });

    expect(combined).toMatchObject({
      imageCache: undefined,
      homeDirectory: fallbackHomeDirectory,
      xdgConfigHome: undefined,
      telemetry: undefined,
    });
  });
});
