/**
 * Fetch and cache OpenRouter rankings per team (docs/design/tier-weights.md §4a).
 *
 * Each team fetches with its own OpenRouter key and its scores feed only its
 * own pools: no tenant's credential serves another. At most one attempt per
 * team per UTC day (three requests), after 03:00 UTC, with no retry. Only
 * derived percentiles are stored, never raw rows or token counts.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from './db/client';
import { systemCache } from './db/schema';
import { resolveInferenceCredential } from './inference-keys';
import type { CatalogEntry } from './model-catalog';
import {
  RANKINGS_FETCH_AFTER_UTC_HOUR,
  RANKINGS_MAX_AGE_DAYS,
  RANKINGS_VIEWS,
  parseRankings,
  rankingsAttemptKey,
  rankingsCacheKey,
  rankingsRequestUrl,
  scoreRankings,
  utcDay,
  type RankingsView,
  type ViewScores,
} from './openrouter-rankings';

const DAY_MS = 86_400_000;

export interface RankingsRefresh {
  status: 'not_due' | 'no_key' | 'fetched';
  /** Views written. */
  written: RankingsView[];
  /** Views whose request failed (HTTP status or 'error'). */
  failed: Array<{ view: RankingsView; status: number | 'error' | 'unparseable' }>;
  unmapped: number;
}

async function readCache<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(systemCache).where(eq(systemCache.key, key)).limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  return row.value as T;
}

async function writeCache(key: string, value: unknown, expiresAt: Date): Promise<void> {
  const now = new Date();
  await db.insert(systemCache).values({ key, value, updatedAt: now, expiresAt })
    .onConflictDoUpdate({ target: systemCache.key, set: { value, updatedAt: now, expiresAt } });
}

/**
 * Fetch the three views for a team if today's attempt has not run yet. The
 * attempt is recorded before the requests, so a failure is not retried today.
 * A non-2xx or unparseable view writes nothing and keeps yesterday's scores.
 */
export async function refreshTeamRankings(args: {
  teamId: string;
  catalog: readonly CatalogEntry[];
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<RankingsRefresh> {
  const out: RankingsRefresh = { status: 'not_due', written: [], failed: [], unmapped: 0 };
  const today = utcDay(args.now);
  if (args.now.getUTCHours() < RANKINGS_FETCH_AFTER_UTC_HOUR) return out;
  const attempt = await readCache<{ date: string }>(rankingsAttemptKey(args.teamId));
  if (attempt?.date === today) return out;

  const cred = await resolveInferenceCredential({ provider: 'openrouter', teamId: args.teamId });
  if (!cred) { out.status = 'no_key'; return out; }

  await writeCache(rankingsAttemptKey(args.teamId), { date: today }, new Date(args.now.getTime() + 2 * DAY_MS));
  out.status = 'fetched';
  const f = args.fetchImpl ?? fetch;
  for (const view of RANKINGS_VIEWS) {
    try {
      const res = await f(rankingsRequestUrl(view, args.now), {
        headers: { accept: 'application/json', authorization: `Bearer ${cred.key}` },
      });
      if (!res.ok) { out.failed.push({ view, status: res.status }); continue; }
      const parsed = parseRankings(await res.json());
      if (!parsed) { out.failed.push({ view, status: 'unparseable' }); continue; }
      const { view: scores, unmapped } = scoreRankings(parsed, args.catalog);
      out.unmapped += unmapped;
      await writeCache(rankingsCacheKey(args.teamId, view), scores, new Date(args.now.getTime() + RANKINGS_MAX_AGE_DAYS * DAY_MS));
      out.written.push(view);
    } catch {
      out.failed.push({ view, status: 'error' });
    }
  }
  return out;
}

/** A team's cached views. Missing or expired views are null. */
export async function loadTeamRankings(teamId: string): Promise<Partial<Record<RankingsView, ViewScores | null>>> {
  const keys = RANKINGS_VIEWS.map(v => rankingsCacheKey(teamId, v));
  const rows = await db.select().from(systemCache).where(inArray(systemCache.key, keys));
  const now = Date.now();
  const out: Partial<Record<RankingsView, ViewScores | null>> = {};
  for (const v of RANKINGS_VIEWS) {
    const row = rows.find(r => r.key === rankingsCacheKey(teamId, v));
    out[v] = row && (!row.expiresAt || row.expiresAt.getTime() > now) ? (row.value as ViewScores) : null;
  }
  return out;
}
