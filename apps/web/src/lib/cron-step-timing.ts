/**
 * Per-step timing for a cron pass that runs its sweeps in one Promise.all.
 *
 * Each step logs its duration as it settles, and a watchdog logs the steps still
 * running after `stallAfterMs`. So a pass cut off at the function's time limit
 * still names the step that held it up: before this, every step's result was
 * logged together after Promise.all, and a timed-out run logged nothing.
 */
export function timedSteps<T extends readonly unknown[]>(
  label: string,
  names: readonly string[],
  steps: T,
  opts: { stallAfterMs?: number; log?: (line: string) => void; now?: () => number } = {},
): { [K in keyof T]: Promise<Awaited<T[K]>> } {
  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now;
  const start = now();
  const pending = new Set<string>(steps.map((_, i) => names[i] ?? String(i)));
  const watchdog = setTimeout(() => {
    if (pending.size > 0) log(`[${label}] still running after ${now() - start}ms: ${[...pending].join(', ')}`);
  }, opts.stallAfterMs ?? 50_000);
  let settled = 0;
  return steps.map((step, i) => {
    const name = names[i] ?? String(i);
    return Promise.resolve(step).finally(() => {
      pending.delete(name);
      log(`[${label}] step=${name} ms=${now() - start}`);
      if (++settled === steps.length) clearTimeout(watchdog);
    });
  }) as unknown as { [K in keyof T]: Promise<Awaited<T[K]>> };
}
