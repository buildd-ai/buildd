import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for the one-time orphaned-schedule backfill
 * (drizzle/0158_backfill_orphaned_mission_schedules.sql,
 * docs/reports/mission-heartbeat-schedule-lifecycle-audit.md §2).
 *
 * There is no live-Postgres harness in the unit suite (no pg-mem/pglite
 * dependency, and worker sandboxes never get a production DATABASE_URL — see
 * CLAUDE.md), so this cannot execute the migration against a real database.
 * Instead it pins the SQL text against the one invariant a regression here
 * would silently violate: the mission-status filter. Widening it to include
 * 'active' would delete the schedule out from under a held/manual mission
 * that is stuck active with no completion path but is still legitimately
 * open — masking that bug instead of fixing it (see audit §3).
 *
 * Renumbered 0155 -> 0156 -> 0158 as concurrent sessions' migrations (0155:
 * add workers.dirty_worktree, PR #2264; then 0156/0157 on dev) landed first —
 * see the schema-change skill on journal index collisions.
 */

const MIGRATION_PATH = join(
  import.meta.dir,
  '..',
  'drizzle',
  '0158_backfill_orphaned_mission_schedules.sql',
);

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, 'utf8');
}

function statusFilterValues(sql: string): string[] {
  const match = /m\.status\s+IN\s*\(([^)]+)\)/i.exec(sql);
  if (!match) throw new Error('Could not find a `m.status IN (...)` filter in the migration');
  return match[1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

describe('0158 backfill: mission-status scope', () => {
  it('only targets terminal statuses, not active or budget_exhausted', () => {
    const values = statusFilterValues(migrationSql());
    expect(new Set(values)).toEqual(new Set(['completed', 'archived']));
  });

  it('never matches an active mission (spares the held/manual-stuck case)', () => {
    const values = statusFilterValues(migrationSql());
    expect(values).not.toContain('active');
    expect(values).not.toContain('budget_exhausted');
    // 'cancelled' is not a real mission status (schema.ts has no such value);
    // asserting its absence here catches a copy-paste of the task brief's
    // wording sneaking a status literal that would never match anything.
    expect(values).not.toContain('cancelled');
  });

  it('deletes the task_schedules row and nulls missions.schedule_id in the same pass', () => {
    const sql = migrationSql();
    expect(sql).toMatch(/UPDATE\s+"missions"[\s\S]*SET\s+schedule_id\s*=\s*NULL/i);
    expect(sql).toMatch(/DELETE FROM\s+"task_schedules"/i);
  });

  it('is registered in the migration journal with a `when` above the prior max', () => {
    const journal = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'drizzle', 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };

    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const ours = entries.find((e) => e.tag === '0158_backfill_orphaned_mission_schedules');
    expect(ours).toBeDefined();

    const priorMax = Math.max(...entries.filter((e) => e.idx < ours!.idx).map((e) => e.when));
    expect(ours!.when).toBeGreaterThan(priorMax);
  });
});
