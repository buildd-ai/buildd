export interface RetryOptions {
  retries: number;
  baseMs?: number;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Calls `fn` up to `retries + 1` times, backing off exponentially between attempts. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const base = opts.baseMs ?? 100;
  let last: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt < opts.retries) await sleep(base * 2 ** attempt);
    }
  }
  throw last;
}
