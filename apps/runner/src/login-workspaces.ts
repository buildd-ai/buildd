/**
 * `buildd login --workspaces` (spec "One runner for every team you run", R-4,
 * AC-4): reopen the consent page for the key this machine already uses, with
 * its current picks, so the person can add or drop workspaces. The key stays
 * the same: nothing is minted and config.json is never written.
 *
 * The edit page (`/api/auth/runner-picks?account=<id>`) is keyed by the key's
 * account id, which the runner reads with its own key from
 * `GET /api/accounts/me`. The page itself is session-only and shows the key
 * only to the person who minted it, so the id in the URL grants nothing.
 *
 * login.ts runs as a script, so this file holds the testable part. Like
 * login.ts it imports only runtime built-ins (install.sh --client checks it out
 * without `bun install`).
 */

import { resolveBuilddServer } from './server-url';
export { DEFAULT_SERVER } from './server-url';

export const PICKS_EDIT_PATH = '/api/auth/runner-picks';

/** The edit page URL for one key. */
export function picksEditUrl(server: string, accountId: string): string {
  return `${server.replace(/\/+$/, '')}${PICKS_EDIT_PATH}?account=${encodeURIComponent(accountId)}`;
}

export interface CurrentKey {
  apiKey: string;
  server: string;
  /** Where the key came from, for the message when it does not work. */
  source: 'env' | 'config';
}

/**
 * The key the runner on this machine uses: BUILDD_API_KEY when set (it
 * overrides config.json for the runner too), else the saved one. The server
 * is the runner's own pick (resolveBuilddServer: `--server`, BUILDD_SERVER,
 * the saved one, buildd.dev), whichever place the key came from.
 */
export function currentKey(
  config: Record<string, unknown>,
  env: Record<string, string | undefined>,
  serverFlag?: string,
): CurrentKey | null {
  const envKey = env.BUILDD_API_KEY?.trim();
  const saved = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const apiKey = envKey || saved;
  if (!apiKey) return null;
  const source = envKey ? 'env' : 'config';
  const server = resolveBuilddServer({ flag: serverFlag, env, saved: config.builddServer });
  return { apiKey, server, source };
}

export type EditOutcome =
  | { ok: true; url: string; accountName: string | null }
  | { ok: false; message: string };

/** Ask the server which account the key is, and build the edit page URL. */
export async function resolvePicksEdit(
  key: CurrentKey,
  fetchImpl: typeof fetch = fetch,
): Promise<EditOutcome> {
  const where = key.source === 'env' ? 'BUILDD_API_KEY' : 'the saved key';
  let res: Response;
  try {
    res = await fetchImpl(`${key.server.replace(/\/+$/, '')}/api/accounts/me`, {
      headers: { Authorization: `Bearer ${key.apiKey}` },
    });
  } catch (err) {
    return { ok: false, message: `Could not reach ${key.server}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 401) {
    return { ok: false, message: `${key.server} does not accept ${where}. Run buildd login to sign in again.` };
  }
  if (!res.ok) {
    return { ok: false, message: `${key.server} answered ${res.status} when asked which key this is. Try again in a moment.` };
  }
  const body = await res.json().catch(() => null) as { id?: unknown; name?: unknown } | null;
  if (!body || typeof body.id !== 'string' || !body.id) {
    return { ok: false, message: `${key.server} did not say which key this is. Try again in a moment.` };
  }
  return { ok: true, url: picksEditUrl(key.server, body.id), accountName: typeof body.name === 'string' ? body.name : null };
}

/** The one line printed before the browser opens; it carries the URL for a headless machine. */
export function editLine(url: string): string {
  return `Opening the page where you choose this runner's workspaces (the key stays the same): ${url}`;
}

export interface RunEditDeps {
  config: Record<string, unknown>;
  env: Record<string, string | undefined>;
  serverFlag?: string;
  fetchImpl?: typeof fetch;
  /** Opens the URL in a browser; a failure only means the person opens it by hand. */
  openUrl: (url: string) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** The whole `--workspaces` command. Returns the exit code. */
export async function runWorkspacesEdit(deps: RunEditDeps): Promise<number> {
  const key = currentKey(deps.config, deps.env, deps.serverFlag);
  if (!key) {
    deps.error('This machine has no buildd key yet. Run buildd login first.');
    return 1;
  }
  const outcome = await resolvePicksEdit(key, deps.fetchImpl);
  if (!outcome.ok) {
    deps.error(outcome.message);
    return 1;
  }
  deps.log(editLine(outcome.url));
  try {
    await deps.openUrl(outcome.url);
  } catch { /* no browser here: the line above has the URL */ }
  return 0;
}
