// Spike checks that need agent credentials (from spike/.env):
//   #2 agent-level env is ignored under createSandbox (docker({ env }) is not)
//   #3 opencode authenticates from its provider env var alone
//   #4 what result.stdout contains per agent (text vs raw stream JSON) → tag extraction
//   #5 `--continue` resumes the just-finished session, per agent
//   #7 token usage / cost obtainable per agent
// Agents without credentials in spike/.env are skipped.
import { type AgentProvider, claudeCode, createSandbox, opencode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IMAGE = 'jig-spike';
const TAG = 'jig-output';

function loadEnv(file: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && match[2]) vars[match[1]!] = match[2].replace(/^["']|["']$/g, '');
  }
  return vars;
}

const env = loadEnv(path.join(import.meta.dirname, '.env'));
const credentialEnv = Object.fromEntries(
  ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']
    .filter((key) => env[key])
    .map((key) => [key, env[key]!]),
);

// Appends a flag to the agent's print command — the planned retry mechanism (spec §9).
const withArgs = (agent: AgentProvider, extra: string): AgentProvider => ({
  ...agent,
  buildPrintCommand: (options) => {
    const built = agent.buildPrintCommand(options);
    return { ...built, command: `${built.command} ${extra}` };
  },
});

function findLastTag(text: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`<${TAG}>([\\s\\S]*?)</${TAG}>`, 'g'))];
  return matches.at(-1)?.[1]?.trim();
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'jig-spike-agents-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'spike@example.com');
  git(dir, 'config', 'user.name', 'spike');
  writeFileSync(path.join(dir, 'README.md'), '# spike\n');
  mkdirSync(path.join(dir, '.sandcastle'), { recursive: true });
  writeFileSync(path.join(dir, '.sandcastle', '.gitignore'), '*\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const agents: { name: string; make: (extraEnv?: Record<string, string>) => AgentProvider }[] = [];
if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) {
  agents.push({ name: 'claude', make: (extraEnv) => claudeCode('haiku', { env: extraEnv }) });
}
if (env.OPENROUTER_API_KEY && env.OPENCODE_MODEL) {
  agents.push({
    name: 'opencode',
    make: (extraEnv) => opencode(env.OPENCODE_MODEL!, { env: extraEnv }),
  });
}
if (agents.length === 0) {
  console.error('No agent credentials in spike/.env — nothing to check.');
  process.exit(1);
}

const repo = makeRepo();
const sandbox = await createSandbox({
  branch: 'jig/run/spike-agents',
  baseBranch: 'main',
  cwd: repo,
  sandbox: docker({ imageName: IMAGE, env: credentialEnv }),
});

const sample = (text: string) =>
  text.length <= 600 ? text : `${text.slice(0, 300)}\n  …\n${text.slice(-300)}`;

try {
  for (const { name, make } of agents) {
    console.log(`\n=== ${name} ===`);

    // #4 / #7: tag in stdout, usage
    const first = await sandbox.run({
      agent: make(),
      prompt: `Reply with exactly this and nothing else: <${TAG}>{"n": 42}</${TAG}>`,
    });
    const tag = findLastTag(first.stdout);
    console.log(`#4 tag found by plain-text search: ${tag ?? '(none)'}`);
    console.log(`#4 stdout looks like raw JSON events: ${/^\s*\{/.test(first.stdout)}`);
    console.log(`#4 stdout sample:\n${sample(first.stdout)}`);
    console.log(`#7 iteration usage: ${JSON.stringify(first.iterations.at(-1)?.usage ?? null)}`);
    const cost = first.stdout.match(/"total_cost_usd"\s*:\s*([0-9.]+)|"cost"\s*:\s*([0-9.]+)/);
    console.log(`#7 cost in stdout: ${cost ? (cost[1] ?? cost[2]) : '(none)'}`);
    console.log(`#3 ${name} authenticated: ${tag !== undefined}`);

    // #5: --continue resumes the session just run
    const resumed = await sandbox.run({
      agent: withArgs(make(), '--continue'),
      prompt: `What number did you put in your previous reply? Reply with exactly: <${TAG}>{"n": <that number>}</${TAG}>`,
    });
    const resumedTag = findLastTag(resumed.stdout);
    console.log(
      `#5 --continue answer: ${resumedTag ?? '(none)'} (42 means the session was resumed)`,
    );

    // #2: agent-level env under createSandbox
    const envCheck = await sandbox.run({
      agent: make({ SPIKE_AGENT_ENV: 'agent-level' }),
      prompt:
        'Run this shell command and report its exact output: echo "[$SPIKE_AGENT_ENV]". ' +
        `Reply with exactly: <${TAG}>{"out": "<the output>"}</${TAG}>`,
    });
    console.log(
      `#2 agent-level env seen by agent: ${findLastTag(envCheck.stdout) ?? '(none)'} ("[]" means ignored)`,
    );
  }
} finally {
  await sandbox.close();
}
