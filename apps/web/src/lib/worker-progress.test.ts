import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { latestMilestoneProgress, workerProgressSql } from './worker-progress';

describe('latestMilestoneProgress', () => {
  it('reads the newest numeric progress', () => {
    expect(latestMilestoneProgress([{ progress: 20 }, { progress: 65 }, {}])).toBe(65);
  });
  it('clamps and ignores non-numbers', () => {
    expect(latestMilestoneProgress([{ progress: 140 }])).toBe(100);
    expect(latestMilestoneProgress([{ progress: '50' }])).toBeNull();
    expect(latestMilestoneProgress(null)).toBeNull();
  });
});

describe('workerProgressSql', () => {
  it('walks the milestone array newest-first and reads only numeric progress', () => {
    const { sql: text } = new PgDialect().sqlToQuery(workerProgressSql);
    expect(text).toContain('jsonb_array_elements(coalesce("workers"."milestones"');
    expect(text).toContain("jsonb_typeof(m->'progress') = 'number'");
    expect(text).toContain('order by i desc limit 1');
  });
});
