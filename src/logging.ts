export function logRun(runId: string, message: string): void {
  console.log(`[sdlc ${runId}] ${new Date().toISOString()} ${message}`);
}
