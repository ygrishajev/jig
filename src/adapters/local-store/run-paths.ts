import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { JIG_DIR } from '../../config/scratch-directory.js';
import type { RunId } from '../../domain/run-id.js';
import { findSymlink } from '../find-symlink.js';

/** This machine's log of a run: what jig did, one line per event. */
export function runLogFile(repoRoot: string, runId: RunId): string {
  return path.join(stateDirectory(repoRoot, runId), 'run.log');
}

export function stateDirectory(repoRoot: string, runId: RunId): string {
  return path.join(runDirectory(repoRoot, runId), 'state');
}

export function runDirectory(repoRoot: string, runId: RunId): string {
  return path.join(repoRoot, JIG_DIR, runId);
}

/** What the agents printed during a run, kept apart from jig's own log. */
export function agentLogFile(repoRoot: string, runId: RunId): string {
  return path.join(stateDirectory(repoRoot, runId), 'agents.log');
}

/** Creates the run's directory under `.jig/`, which ignores itself so it never dirties the target repo. */
export async function makeRunDirectory(repoRoot: string, runId: RunId): Promise<string> {
  const directory = runDirectory(repoRoot, runId);
  await mkdir(directory, { recursive: true });
  await ignoreJigDirectory(repoRoot);
  return directory;
}

export async function ignoreJigDirectory(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, JIG_DIR), { recursive: true });
  const gitignore = path.join(repoRoot, JIG_DIR, '.gitignore');
  if (!existsSync(gitignore)) await writeFile(gitignore, '*\n');
}

/**
 * The first link among the paths a run reads and writes. Each level is checked before it is
 * listed, so the listing never follows a link. Worktrees below these levels may hold links freely.
 */
export function findLinkInRunDirectory(repoRoot: string, runId: RunId): string | undefined {
  const jigDirectory = path.join(repoRoot, JIG_DIR);
  const directory = runDirectory(repoRoot, runId);
  return (
    findSymlink([jigDirectory, path.join(jigDirectory, '.gitignore'), directory]) ??
    findSymlink(entriesOf(directory)) ??
    findSymlink(entriesOf(stateDirectory(repoRoot, runId)))
  );
}

function entriesOf(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).map((entry) => path.join(directory, entry));
}
