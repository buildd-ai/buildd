import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

let tables: { links?: any[]; skills: any[]; started: string | null; schedules: any[]; active: string[] };
const executed: string[] = [];
const dialect = new PgDialect();

const mockExecute = mock(async (q: any) => {
  const text = dialect.sqlToQuery(q).sql;
  executed.push(text);
  if (text.includes('FROM skill_spec_links')) return { rows: tables.links ?? [] };
  if (text.includes('FROM workspace_skills WHERE enabled')) return { rows: tables.skills };
  if (text.includes('FROM workspace_skills s')) return { rows: tables.skills };
  if (text.includes('min(first_claimed_at)')) return { rows: [{ started: tables.started }] };
  if (text.includes('FROM task_schedules')) return { rows: tables.schedules };
  if (text.includes('jsonb_array_elements_text')) return { rows: tables.active.map(slug => ({ slug })) };
  if (text.includes('UPDATE workspace_skills')) return { rows: [{ id: 'x' }] };
  return { rows: [] };
});
mock.module('@buildd/core/db', () => ({ db: { execute: mockExecute } }));
process.env.CRON_SECRET = 'test-secret';

import { GET } from './route';

const skill = (o: Record<string, unknown>) => ({
  id: '00000000-0000-0000-0000-00000000000' + (o.n ?? 1), team_id: '00000000-0000-0000-0000-0000000000aa',
  slug: 'old', enabled: true, is_role: false, pinned: false, content: 'c', content_hash: 'h',
  created_at: ago(300), last_claimed_at: null, last_restored_at: null, ...o,
});
const req = (token = 'test-secret') =>
  new NextRequest('http://localhost/api/cron/skill-lifecycle', { headers: { authorization: `Bearer ${token}` } });
const updates = () => executed.filter(q => q.includes('UPDATE workspace_skills'));
const inserts = () => executed.filter(q => q.includes('INSERT INTO skill_lifecycle_events'));

beforeEach(() => {
  executed.length = 0;
  mockExecute.mockClear();
  delete process.env.SKILL_RETIREMENT_MODE;
  tables = { skills: [skill({})], started: ago(120), schedules: [], active: [] };
});

describe('GET /api/cron/skill-lifecycle', () => {
  it('rejects a wrong secret without touching the db', async () => {
    const res = await GET(req('nope'));
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('defaults to recording: writes an event and never updates a skill', async () => {
    const res = await GET(req());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: 'recording', archivable: 1, archived: 0 });
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
  });

  it('acting mode disables the archivable skill and audits it', async () => {
    process.env.SKILL_RETIREMENT_MODE = 'acting';
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ mode: 'acting', archived: 1 });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toContain('enabled = false');
    expect(updates()[0]).not.toMatch(/DELETE/i);
    expect(inserts()).toHaveLength(1);
  });

  it('archives nothing while telemetry is younger than the archive window', async () => {
    process.env.SKILL_RETIREMENT_MODE = 'acting';
    tables.started = ago(20);
    const body = await (await GET(req())).json();
    expect(body.archivable).toBe(0);
    expect(updates()).toHaveLength(0);
  });

  it.each([
    ['a disabled schedule template naming it', { schedules: [{ task_template: { context: { skillSlugs: ['old'] } } }] }],
    ['a schedule template skillSlugs field', { schedules: [{ task_template: { skillSlugs: ['old'] } }] }],
    ['a running task context naming it', { active: ['old'] }],
    ['a default role slug', { skills: [skill({ slug: 'builder' })] }],
    ['a role row', { skills: [skill({ is_role: true })] }],
    ['a pinned skill', { skills: [skill({ pinned: true })] }],
  ])('exempts a skill protected by %s', async (_n, patch) => {
    process.env.SKILL_RETIREMENT_MODE = 'acting';
    tables = { ...tables, ...patch } as typeof tables;
    const body = await (await GET(req())).json();
    expect(body.archivable).toBe(0);
    expect(updates()).toHaveLength(0);
  });

  describe('confirmed spec links', () => {
    const link = (status: string) => ({ skill_id: '00000000-0000-0000-0000-000000000001', spec_id: 'sp', spec_status: status });
    beforeEach(() => { tables.started = ago(5); }); // young telemetry: nothing is archivable

    it('no confirmed link: no proposal event', async () => {
      await GET(req());
      expect(inserts().join()).not.toContain('retirement_proposed');
      expect(inserts()).toHaveLength(0);
    });
    it('a confirmed link to a retired spec writes a proposal event and never disables, even in acting mode', async () => {
      process.env.SKILL_RETIREMENT_MODE = 'acting';
      tables.links = [link('retired')];
      await GET(req());
      expect(inserts()).toHaveLength(1);
      expect(updates()).toHaveLength(0);
    });
  });
});
