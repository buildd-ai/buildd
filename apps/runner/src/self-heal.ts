import { execFile } from 'child_process';

export const SELF_HEAL_INTERVAL_MS = 30 * 60_000;

interface SelfHealOptions {
  executable?: string;
  args?: string[];
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Allows a fixture to confirm the child is blocking before probing health. */
  onStdout?: (chunk: string) => void;
}

/** Keep synchronous doctor checks and repairs off the runner's event loop. */
export function createPeriodicSelfHeal(options: SelfHealOptions = {}): () => Promise<void> {
  const now = options.now ?? Date.now;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  let lastRun = now();
  let running = false;
  return async () => {
    if (running || now() - lastRun < SELF_HEAL_INTERVAL_MS) return;
    lastRun = now();
    running = true;
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const child = execFile(options.executable ?? process.execPath,
          options.args ?? [process.argv[1], '--doctor', '--fix'], {
            encoding: 'utf-8', timeout: options.timeoutMs ?? 5 * 60_000,
            maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' },
          }, (err, stdout, stderr) => {
            // Doctor uses exit 1 for diagnostic errors, even after normal repairs.
            // Output alone never proves repairs completed: it precedes autoFix.
            if (err && !(err.code === 1 && !err.killed && !err.signal)) {
              reject(new Error(`${err.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
            } else {
              resolve(stdout);
            }
          });
        if (options.onStdout) child.stdout?.on('data', options.onStdout);
      });
      const fixes = out.replace(/\x1b\[[0-9;]*m/g, '').split('Auto-fixes:')[1];
      if (fixes) {
        for (const line of fixes.split('\n').map(l => l.trim()).filter(Boolean)) {
          log(`[self-heal] ${line}`);
        }
      }
    } catch (err) {
      error(`[self-heal] Doctor check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
}
