import { Result } from 'better-result';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { simpleGit } from 'simple-git';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

import { ConfigInvalid, type LocalStateUnwritable, messageOf } from '../../domain/errors.js';
import { refuseSymlinks } from '../find-symlink.js';
import { onLocalState } from './local-state.js';
import { ignoreJigDirectory, JIG_DIR } from './run-paths.js';

export function readCredentialsFile(
  repoRoot: string,
): Result<Record<string, string>, ConfigInvalid> {
  const file = path.join(repoRoot, CREDENTIALS_FILE);
  const refused = refuseSymlinks([path.join(repoRoot, JIG_DIR), file]);
  if (refused.isErr()) return Result.err(refused.error);
  if (!existsSync(file)) return Result.ok({});
  return Result.try({
    try: () => readFileSync(file, 'utf-8'),
    catch: (cause) =>
      new ConfigInvalid({ message: `Cannot read ${CREDENTIALS_FILE}: ${messageOf(cause)}` }),
  }).andThen(parseCredentials);
}

/** Credentials the operator keeps for this repository, relative to its root. */
export const CREDENTIALS_FILE = `${JIG_DIR}/.env`;

/** Parser and schema diagnostics can quote the file, so the error names only the file. */
function parseCredentials(text: string): Result<Record<string, string>, ConfigInvalid> {
  const unreadableCredentials = (): ConfigInvalid =>
    new ConfigInvalid({ message: `Cannot parse ${CREDENTIALS_FILE} as a dotenv file.` });
  return Result.try({ try: (): unknown => parseEnv(text), catch: unreadableCredentials }).andThen(
    (parsed) => {
      const credentials = credentialsSchema.safeParse(parsed);
      return credentials.success
        ? Result.ok(credentials.data)
        : Result.err(unreadableCredentials());
    },
  );
}

const credentialsSchema = z.record(z.string(), z.string());

/** Sets one credential, keeping the rest of the file, readable only by the operator. */
export async function saveCredential(
  repoRoot: string,
  name: string,
  value: string,
): Promise<Result<void, ConfigInvalid | LocalStateUnwritable>> {
  const directory = path.join(repoRoot, JIG_DIR);
  const file = path.join(repoRoot, CREDENTIALS_FILE);
  const gitignore = path.join(directory, '.gitignore');
  const refused = refuseSymlinks([directory, gitignore, file]);
  if (refused.isErr()) return Result.err(refused.error);
  const ignored = await onLocalState(file, async () => {
    await ignoreJigDirectory(repoRoot);
    return simpleGit({ baseDir: repoRoot }).checkIgnore(CREDENTIALS_FILE);
  });
  if (ignored.isErr()) return Result.err(ignored.error);
  if (ignored.value.length === 0) {
    return Result.err(
      new ConfigInvalid({
        message: `Not saving a credential to ${CREDENTIALS_FILE}: git tracks that file or does not ignore it.`,
      }),
    );
  }
  return onLocalState(file, async () => {
    const current = existsSync(file) ? await readFile(file, 'utf-8') : '';
    const others = current.split('\n').filter((line) => line && !line.startsWith(`${name}=`));
    const lines = [...others, `${name}="${value}"`];
    await writeFileAtomic(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  });
}
