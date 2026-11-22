import {
  configDestination,
  configFileSource,
} from '../../src/adapters/filesystem/config-source.js';
import { type JigConfig, loadConfig } from '../../src/config/load-config.js';
import { unwrap } from './unwrap.js';

/** The config a command started in the repository would load from its own settings file. */
export function repositoryConfig(repoRoot: string): JigConfig {
  return unwrap(loadConfig(configFileSource(configDestination(repoRoot))));
}
