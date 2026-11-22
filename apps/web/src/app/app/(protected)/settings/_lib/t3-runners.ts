import { db } from '@buildd/core/db';
import { workerHeartbeats } from '@buildd/core/db/schema';
import { desc, inArray, sql } from 'drizzle-orm';
import { acpLineFor } from './t3-runner-line';
import type { T3Runner } from '../connections/T3CodeSection';

/** One line per runner under the person's own keys, from each runner's own report. */
export async function loadT3Runners(accountIds: string[]): Promise<T3Runner[]> {
  if (accountIds.length === 0) return [];
  const rows = await db
    .select({
      id: workerHeartbeats.id,
      localUiUrl: workerHeartbeats.localUiUrl,
      name: sql<string | null>`${workerHeartbeats.environment}->'labels'->>'name'`,
      acp: sql<unknown>`${workerHeartbeats.environment}->'acp'`,
    })
    .from(workerHeartbeats)
    .where(inArray(workerHeartbeats.accountId, accountIds))
    .orderBy(desc(workerHeartbeats.lastHeartbeatAt))
    .limit(20)
    .catch(() => [] as never[]);
  return rows.map((r) => {
    let host = r.localUiUrl;
    try { host = new URL(r.localUiUrl).hostname || r.localUiUrl; } catch { /* keep as sent */ }
    return { id: r.id, name: r.name || host, ...acpLineFor({ acp: r.acp }) };
  });
}
