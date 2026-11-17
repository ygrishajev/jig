import type { Issue } from './github-port.js';

export function requestText(issue: Issue): string {
  return `# ${issue.title}\n\n${issue.body}\n\nSource: ${issue.url}\n`;
}
