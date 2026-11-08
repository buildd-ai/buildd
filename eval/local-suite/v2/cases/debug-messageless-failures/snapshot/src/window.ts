const DAY_MS = 24 * 3600 * 1000;

export function inWindow(atMs: number, nowMs = Date.now()): boolean {
  return nowMs - atMs <= DAY_MS;
}
