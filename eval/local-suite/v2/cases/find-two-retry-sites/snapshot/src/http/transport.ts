import { isTransient } from './errors';

const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;

const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, ms));

export async function sendWithBackoff(
  url: string,
  attempts = 5,
): Promise<Response> {
  let delay = BASE_DELAY_MS;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!isTransient(res.status)) return res;
    } catch {
      // network error: wait, then try again
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
  throw new Error('gave up after retries');
}
