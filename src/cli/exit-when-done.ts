import type { Writable } from 'node:stream';

/**
 * Ends the process once its output is written. A library can leave a timer running after the
 * command is done (sandcastle's idle warning once did), and that alone keeps Node alive.
 */
export async function exitWhenDone(
  outputs: Writable[] = [process.stdout, process.stderr],
  exit: () => void = () => process.exit(),
): Promise<void> {
  await Promise.all(outputs.map(drained));
  exit();
}

function drained(output: Writable): Promise<void> {
  return new Promise((resolve) => output.write('', () => resolve()));
}
