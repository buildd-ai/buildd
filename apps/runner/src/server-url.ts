/**
 * Which buildd server this machine talks to: `--server`, then BUILDD_SERVER,
 * then the saved `builddServer`, then buildd.dev. The runner (index.ts) and
 * `buildd login --workspaces` (login-workspaces.ts) both read it here, so the
 * same key is never sent to two different servers.
 *
 * Runtime built-ins only: install.sh --client checks this file out without
 * `bun install`.
 */
export const DEFAULT_SERVER = 'https://buildd.dev';

export function resolveBuilddServer(opts: {
  flag?: string | null;
  env?: Record<string, string | undefined>;
  saved?: unknown;
}): string {
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return pick(opts.flag) || pick(opts.env?.BUILDD_SERVER) || pick(opts.saved) || DEFAULT_SERVER;
}
