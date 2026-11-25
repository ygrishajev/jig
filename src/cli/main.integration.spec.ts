import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

describe('buildCli', () => {
  it('prints run help in a process without GitHub configuration', async () => {
    const { printRunHelp } = setup();

    const result = await printRunHelp();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Usage: jig run /m);
  }, 30_000);

  function setup() {
    const githubConfiguration = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_REPOSITORY']);
    const environmentWithoutGithub = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !githubConfiguration.has(name)),
    );
    const coreBuilder = new URL('./main.ts', import.meta.url).href;
    const script = [
      `import { buildCli } from ${JSON.stringify(coreBuilder)};`,
      `await buildCli({}, {}).parseAsync(['run', '--help'], { from: 'user' });`,
    ].join('\n');
    return {
      printRunHelp: () =>
        execa(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
          env: environmentWithoutGithub,
          extendEnv: false,
          reject: false,
        }),
    };
  }
});
