// Follow-up spike checks:
//   #5 `--continue` resumes the session — with a random number, so a fresh session can't guess it
//   #7 cost/usage from raw stream lines, captured by wrapping parseStreamLine
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeCode, createSandbox, opencode, type AgentProvider } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';

const IMAGE = 'sdlc-spike';
const TAG = 'sdlc-output';

const env: Record<string, string> = {};
for (const line of readFileSync(path.join(import.meta.dirname, '.env'), 'utf-8').split('\n')) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (match && match[2]) env[match[1]!] = match[2].replace(/^["']|["']$/g, '');
}
const credentialEnv = Object.fromEntries(
  ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY'].filter((k) => env[k]).map((k) => [k, env[k]!]),
);

// The two wrappers sdlc would own: extra CLI args, and a raw-line tap.
const withArgs = (agent: AgentProvider, extra: string): AgentProvider => ({
  ...agent,
  buildPrintCommand: (options) => {
    const built = agent.buildPrintCommand(options);
    return { ...built, command: `${built.command} ${extra}` };
  },
});
const withRawTap = (agent: AgentProvider, onRaw: (line: string) => void): AgentProvider => ({
  ...agent,
  parseStreamLine: (line) => {
    onRaw(line);
    return agent.parseStreamLine(line);
  },
});

const lastTag = (text: string) =>
  [...text.matchAll(new RegExp(`<${TAG}>([\\s\\S]*?)</${TAG}>`, 'g'))].at(-1)?.[1]?.trim();

interface RawPart {
  type?: string;
  cost?: number;
  tokens?: unknown;
}

interface RawEvent {
  type?: string;
  total_cost_usd?: number;
  usage?: unknown;
  part?: RawPart;
  properties?: { part?: RawPart };
}

function usageFromRaw(lines: string[]): unknown[] {
  const found: unknown[] = [];
  for (const line of lines) {
    let event: RawEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // claude: the final {"type":"result"} event carries total_cost_usd + usage
    if (event.type === 'result' && 'total_cost_usd' in event) {
      found.push({ source: 'claude result', cost_usd: event.total_cost_usd, usage: event.usage });
    }
    // opencode: step-finish parts carry tokens + cost
    const part = event.part ?? event.properties?.part;
    if (part?.type === 'step-finish' || (part && 'cost' in part && 'tokens' in part)) {
      found.push({ source: `opencode ${event.type}`, cost: part.cost, tokens: part.tokens });
    }
  }
  return found;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'sdlc-spike-usage-')));
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 'spike@example.com');
git(repo, 'config', 'user.name', 'spike');
writeFileSync(path.join(repo, 'README.md'), '# spike\n');
mkdirSync(path.join(repo, '.sandcastle'), { recursive: true });
writeFileSync(path.join(repo, '.sandcastle', '.gitignore'), '*\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init');

const agents: [string, () => AgentProvider][] = [
  ['claude', () => claudeCode('haiku')],
  ['opencode', () => opencode(env.OPENCODE_MODEL!)],
];

const sandbox = await createSandbox({
  branch: 'sdlc/run/spike-usage',
  baseBranch: 'main',
  cwd: repo,
  sandbox: docker({ imageName: IMAGE, env: credentialEnv }),
});

try {
  for (const [name, make] of agents) {
    console.log(`\n=== ${name} ===`);
    const secret = 1000 + Math.floor(Math.random() * 9000);
    const raw: string[] = [];

    const first = await sandbox.run({
      agent: withRawTap(make(), (line) => raw.push(line)),
      prompt: `Remember the number ${secret}. Reply with exactly: <${TAG}>{"ok": true}</${TAG}>`,
    });
    console.log(`first reply: ${lastTag(first.stdout) ?? '(none)'}`);
    console.log(`#7 raw lines captured: ${raw.length}`);
    console.log(`#7 usage/cost found in raw events: ${JSON.stringify(usageFromRaw(raw), null, 2)}`);
    if (usageFromRaw(raw).length === 0) {
      console.log(
        `#7 raw event types: ${[
          ...new Set(
            raw.map((l) => {
              try {
                const e = JSON.parse(l);
                return `${e.type}${e.part?.type ? '/' + e.part.type : ''}`;
              } catch {
                return 'non-json';
              }
            }),
          ),
        ].join(', ')}`,
      );
    }

    const resumed = await sandbox.run({
      agent: withArgs(make(), '--continue'),
      prompt: `Which number did I ask you to remember? Reply with exactly: <${TAG}>{"n": <the number>}</${TAG}>`,
    });
    const answer = lastTag(resumed.stdout);
    console.log(
      `#5 --continue: expected ${secret}, got ${answer ?? '(none)'} → ${answer?.includes(String(secret)) ? 'RESUMED' : 'NOT resumed'}`,
    );
  }
} finally {
  await sandbox.close();
}
