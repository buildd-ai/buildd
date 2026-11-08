// Generic retry helper with growing waits.
export interface RetryOptions {
  tries: number;
  baseMs: number;
  factor: number;
  capMs: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  o: RetryOptions,
): Promise<T> {
  let wait = o.baseMs;
  let last: unknown;
  for (let i = 0; i < o.tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * o.factor, o.capMs);
    }
  }
  throw last;
}
