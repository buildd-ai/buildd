import { after } from 'next/server';
import { db } from '@buildd/core/db';
import { connectors } from '@buildd/core/db/schema';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { resolveConnectorIconData } from './connector-icon';

/**
 * Keeps `connectors.iconUrl` filled for rows created before icons were
 * resolved, rows whose server was unreachable at create time, and rows that
 * still hotlink a remote URL. A list request schedules a few lookups after
 * the response; `iconCheckedAt` limits each row to one attempt per TTL.
 */

export const ICON_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_REQUEST = 3;

export interface IconRow {
  id: string;
  url: string;
  transport: string;
  iconUrl: string | null;
  iconCheckedAt: Date | null;
}

export function needsIconRefresh(c: IconRow, now = Date.now()): boolean {
  if (c.transport !== 'http' || !c.url) return false;
  if (c.iconUrl?.startsWith('data:')) return false;
  return !c.iconCheckedAt || now - c.iconCheckedAt.getTime() > ICON_RECHECK_MS;
}

/**
 * The value to store after a lookup, or undefined to leave the row alone. A
 * remote URL that would not download is dropped rather than kept hotlinked.
 */
export function nextIconValue(current: string | null, found: string | null): string | null | undefined {
  if (found) return found === current ? undefined : found;
  return current && !current.startsWith('data:') ? null : undefined;
}

/**
 * Look the icon up again and store it. `force` skips the TTL claim and the
 * stored icon, e.g. right after OAuth connect, when `headers` carries a
 * bearer that lets `initialize` answer with `serverInfo.icons`.
 */
export async function refreshConnectorIcon(
  c: Pick<IconRow, 'id' | 'url' | 'iconUrl'>,
  opts: { headers?: Record<string, string>; force?: boolean } = {},
): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ICON_RECHECK_MS);
  // Claim the attempt first so concurrent list requests probe a server once.
  const claimed = await db.update(connectors)
    .set({ iconCheckedAt: now })
    .where(opts.force
      ? eq(connectors.id, c.id)
      : and(eq(connectors.id, c.id), or(isNull(connectors.iconCheckedAt), lt(connectors.iconCheckedAt, cutoff))))
    .returning({ id: connectors.id });
  if (claimed.length === 0) return;

  const found = await resolveConnectorIconData(c.url, { headers: opts.headers, preferred: opts.force ? null : c.iconUrl });
  const next = nextIconValue(c.iconUrl, found);
  if (next !== undefined) await db.update(connectors).set({ iconUrl: next }).where(eq(connectors.id, c.id));
}

/**
 * After OAuth connect: `initialize` with the fresh bearer, which is the only
 * way an auth-gated server's own `serverInfo.icons` can be read.
 */
export function scheduleAuthedIconRefresh(c: Pick<IconRow, 'id' | 'url' | 'iconUrl'>, accessToken: string): void {
  after(async () => {
    await refreshConnectorIcon(c, { headers: { authorization: `Bearer ${accessToken}` }, force: true }).catch(() => {});
  });
}

/** Schedule lookups for a few stale rows after the current response is sent. */
export function scheduleStaleIconRefresh(rows: IconRow[]): void {
  const stale = rows.filter(r => needsIconRefresh(r)).slice(0, MAX_PER_REQUEST);
  if (stale.length === 0) return;
  after(async () => {
    await Promise.allSettled(stale.map(r => refreshConnectorIcon(r)));
  });
}
