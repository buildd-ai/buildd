import { describe, it, expect, mock } from 'bun:test';

// Mock drizzle-orm's `sql` tag + the db module BEFORE consolidation is loaded —
// identical shape to knowledge-consolidation.test.ts (bun's mock.module is
// process-global; keeping the shape identical makes full-suite and standalone
// runs behave the same). The schedule constants touch no DB, but importing the
// module still evaluates its top-level imports.
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));
mock.module('../db/index', () => ({ db: { execute: () => Promise.resolve({ rows: [] }) } }));

const { WEEKLY_DIGEST_SCHEDULE, WEEKLY_CONSOLIDATION_SCHEDULE } = await import('../knowledge-store/consolidation');

describe('WEEKLY_DIGEST_SCHEDULE', () => {
  it('is a complete taskSchedules payload with a weekly cron', () => {
    expect(WEEKLY_DIGEST_SCHEDULE.name).toBe('knowledge-digest');
    // 5-field cron, weekly (day-of-month wildcard, day-of-week set)
    const fields = WEEKLY_DIGEST_SCHEDULE.cronExpression.split(' ');
    expect(fields).toHaveLength(5);
    expect(fields[2]).toBe('*');
    expect(fields[4]).not.toBe('*');
    expect(WEEKLY_DIGEST_SCHEDULE.timezone).toBe('UTC');
    expect(WEEKLY_DIGEST_SCHEDULE.maxConcurrentFromSchedule).toBe(1);
    expect(WEEKLY_DIGEST_SCHEDULE.taskTemplate.title.length).toBeGreaterThan(0);
  });

  it('does not collide with the consolidation schedule name', () => {
    expect(WEEKLY_DIGEST_SCHEDULE.name).not.toBe(WEEKLY_CONSOLIDATION_SCHEDULE.name);
  });

  it('prompt covers the 7-day window, all three sources, and a summary artifact', () => {
    const prompt = WEEKLY_DIGEST_SCHEDULE.taskTemplate.description ?? '';
    expect(prompt).toContain('7 days');
    // Three sources: PRs, tasks, memories
    expect(prompt.toLowerCase()).toContain('merged pr');
    expect(prompt).toContain('list_tasks');
    expect(prompt).toContain('buildd_memory');
    // Saved as an auto-indexed summary artifact (the whole deliverable)
    expect(prompt).toContain('create_artifact');
    expect(prompt).toContain('type=summary');
    // Digest is a summary task, not a code change
    expect(prompt.toLowerCase()).toContain('do not open a pr');
  });
});
