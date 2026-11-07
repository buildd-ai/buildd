/**
 * Skill usage telemetry (record-only): one atomic upsert raises the claim
 * count of every skill a claim delivered. A single statement, never
 * a transaction (neon-http has none). A write failure is swallowed: telemetry
 * must never refuse a claim.
 */
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

export interface SkillUsageInput {
  teamId: string;
  skillIds: readonly string[];
  now: Date;
  /** Test seam: receives the rendered statement text. Default runs it on the db. */
  exec?: (statement: string, params: unknown[]) => Promise<unknown>;
}

/** The single multi-row upsert; null when there is nothing to count. */
export function buildSkillUsageUpsert(input: Pick<SkillUsageInput, 'teamId' | 'skillIds' | 'now'>): SQL | null {
  const ids = [...new Set(input.skillIds)];
  if (ids.length === 0) return null;
  const at = input.now.toISOString();
  const rows = sql.join(
    ids.map(id => sql`(${id}::uuid, ${input.teamId}::uuid, 1, ${at}::timestamptz, ${at}::timestamptz)`),
    sql`, `,
  );
  return sql`INSERT INTO skill_usage (skill_id, team_id, claim_count, first_claimed_at, last_claimed_at)
VALUES ${rows}
ON CONFLICT (skill_id) DO UPDATE SET claim_count = skill_usage.claim_count + 1, last_claimed_at = EXCLUDED.last_claimed_at`;
}

export async function recordSkillUsage(input: SkillUsageInput): Promise<void> {
  try {
    const stmt = buildSkillUsageUpsert(input);
    if (!stmt) return;
    if (input.exec) {
      const q = new PgDialect().sqlToQuery(stmt);
      await input.exec(q.sql, q.params);
      return;
    }
    const { db } = await import('./db');
    await db.execute(stmt);
  } catch (err) {
    console.warn('[skill-usage] write failed (claim unaffected):', err instanceof Error ? err.message : err);
  }
}
