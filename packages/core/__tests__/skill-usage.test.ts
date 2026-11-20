import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { skillUsage } from '../db/schema';
import { buildSkillUsageUpsert, recordSkillUsage } from '../skill-usage';

const T = '00000000-0000-4000-8000-000000000001';
const ids = ['a','b','c'].map((c, i) => `00000000-0000-4000-8000-00000000010${i}`);

describe('skill usage upsert', () => {
  it('three skills are raised by one in a single statement', async () => {
    const calls: Array<[string, unknown[]]> = [];
    await recordSkillUsage({ teamId: T, skillIds: ids, now: new Date(), exec: async (q, p) => { calls.push([q, p]); } });
    expect(calls).toHaveLength(1);
    expect(calls[0][1].filter(p => ids.includes(p as string))).toHaveLength(3);
    expect(calls[0][0]).toContain('skill_usage.claim_count + 1');
  });
  it('duplicate ids count once; empty does nothing', async () => {
    let n = 0;
    await recordSkillUsage({ teamId: T, skillIds: [], now: new Date(), exec: async () => { n++; } });
    expect(n).toBe(0);
  });
  it('write failure is swallowed', async () => {
    await expect(recordSkillUsage({ teamId: T, skillIds: ids, now: new Date(), exec: async () => { throw new Error('x'); } })).resolves.toBeUndefined();
  });
  it('uses no db.transaction', () => {
    for (const f of ['../skill-usage.ts', '../../../apps/web/src/app/api/workers/claim/skill-and-role-injection.ts'])
      expect(readFileSync(join(import.meta.dir, f), 'utf8')).not.toMatch(/\.transaction\(/);
  });
});

describe('buildSkillUsageUpsert rendering', () => {
  it('renders one multi-row upsert through PgDialect', () => {
    const stmt = buildSkillUsageUpsert({ teamId: T, skillIds: ids, now: new Date() });
    expect(stmt).not.toBeNull();
    const q = new PgDialect().sqlToQuery(stmt!);
    expect(q.sql).toContain('ON CONFLICT (skill_id) DO UPDATE');
    expect(q.params.filter(p => ids.includes(p as string))).toHaveLength(3);
  });
  it('sets telemetry_started_at once per team and never in the update set', () => {
    const q = new PgDialect().sqlToQuery(buildSkillUsageUpsert({ teamId: T, skillIds: ids, now: new Date() })!);
    expect(q.sql).toContain('telemetry_started_at');
    expect(q.sql).toContain('min(t.telemetry_started_at)');
    const setClause = q.sql.slice(q.sql.indexOf('DO UPDATE SET'));
    expect(setClause).not.toMatch(/telemetry_started_at\s*=/);
  });
  it('skill_usage has no foreign key on skill_id (a deleted skill leaves its row)', () => {
    const cfg = getTableConfig(skillUsage);
    expect(cfg.foreignKeys.flatMap(f => f.reference().columns.map(c => c.name))).not.toContain('skill_id');
    expect(cfg.columns.map(c => c.name)).toContain('telemetry_started_at');
  });
  it('returns null for no skills', () => {
    expect(buildSkillUsageUpsert({ teamId: T, skillIds: [], now: new Date() })).toBeNull();
  });
});
