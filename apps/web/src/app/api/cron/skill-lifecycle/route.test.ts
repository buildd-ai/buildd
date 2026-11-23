import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

let tables: { teamStarted?: Record<string, string>; links?: any[]; skills: any[]; started: string | null; schedules: any[]; active: string[] };
const executed: string[] = [];
const dialect = new PgDialect();

const mockExecute = mock(async (q: any) => {
  const text = dialect.sqlToQuery(q).sql;
  executed.push(text);
  if (text.includes('FROM skill_spec_links')) return { rows: tables.links ?? [] };
  if (text.includes('FROM workspace_skills WHERE enabled')) return { rows: tables.skills };
  if (text.includes('FROM workspace_skills s')) return { rows: tables.skills };
  if (text.includes('min(telemetry_started_at)')) {
    const byTeam = tables.teamStarted ?? (tables.started ? { '00000000-0000-0000-0000-0000000000aa': tables.started } : {});
    return { rows: Object.entries(byTeam).map(([team_id, started]) => ({ team_id, started })) };
  }
  if (text.includes('FROM task_schedules')) return { rows: tables.schedules };
  if (text.includes('jsonb_array_elements_text')) return { rows: tables.active.map(slug => ({ slug })) };
  if (text.includes('UPDATE workspace_skills')) return { rows: [{ id: 'x' }] };
  return { rows: [] };
});
mock.module('@buildd/core/db', () => ({ db: { execute: mockExecute } }));
process.env.CRON_SECRET = 'test-secret';

import { GET } from './route';

const WS = '00000000-0000-0000-0000-0000000000bb';
const skill = (o: Record<string, unknown>) => ({
  id: '00000000-0000-0000-0000-00000000000' + (o.n ?? 1), team_id: '00000000-0000-0000-0000-0000000000aa',
  workspace_id: WS, git_config: { skillRetirement: { mode: 'acting' } },
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
  delete process.env.SKILL_RETIREMENT_ACTING_WORKSPACES;
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
    expect(body).toMatchObject({ ok: true, archivable: 1, archived: 0 });
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
  });

  it('acting mode disables the archivable skill and audits it', async () => {
    process.env.SKILL_RETIREMENT_ACTING_WORKSPACES = WS;
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ archived: 1 });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toContain('enabled = false');
    expect(updates()[0]).not.toMatch(/DELETE/i);
    expect(inserts()).toHaveLength(1);
  });

  it('acting configured but workspace not allowlisted: refused, recorded only', async () => {
    delete process.env.SKILL_RETIREMENT_ACTING_WORKSPACES;
    const body = await (await GET(req())).json();
    expect(body.archived).toBe(0);
    expect(body.refusals[0]).toMatchObject({ refusal: 'not_allowlisted' });
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
  });

  it('unrecognised mode resolves to recording', async () => {
    process.env.SKILL_RETIREMENT_ACTING_WORKSPACES = WS;
    tables.skills = [skill({ git_config: { skillRetirement: { mode: 'ACT' } } })];
    const body = await (await GET(req())).json();
    expect(body.archived).toBe(0);
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(1);
  });

  it('off does nothing: no event, no update', async () => {
    tables.skills = [skill({ git_config: { skillRetirement: { mode: 'off' } } })];
    const body = await (await GET(req())).json();
    expect(body.archivable).toBe(0);
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
  });

  it('acting is refused before the archive window and says so', async () => {
    process.env.SKILL_RETIREMENT_ACTING_WORKSPACES = WS;
    tables.started = ago(20);
    const body = await (await GET(req())).json();
    expect(body.refusals[0]).toMatchObject({ refusal: 'archive_window_not_elapsed', telemetryDays: 20, archiveDays: 60 });
    expect(updates()).toHaveLength(0);
  });

  it('archives nothing while telemetry is younger than the archive window', async () => {
    process.env.SKILL_RETIREMENT_ACTING_WORKSPACES = WS;
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
    process.env.SKILL_RETIREMENT_ACTING_WORKSPACES = WS;
    tables = { ...tables, ...patch } as typeof tables;
    const body = await (await GET(req())).json();
    expect(body.archivable).toBe(0);
    expect(updates()).toHaveLength(0);
  });

  it('per-team clock: a team 10d into telemetry is not archivable though another is 90d in', async () => {
    process.env.SKILL_RETIREMENT_ACTING_WORKSPACES = WS;
    const A = '00000000-0000-0000-0000-0000000000aa', B = '00000000-0000-0000-0000-0000000000cc';
    tables.teamStarted = { [A]: ago(90), [B]: ago(10) };
    tables.skills = [skill({ n: 1, team_id: A }), skill({ n: 2, team_id: B, slug: 'other', created_at: ago(300) })];
    const body = await (await GET(req())).json();
    expect(body.archived).toBe(1);
    expect(updates()).toHaveLength(1);
    expect(inserts().length).toBe(1);
    expect(body.refusals.some((r: any) => r.refusal === 'archive_window_not_elapsed' && r.telemetryDays === 10)).toBe(true);
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
      process.env.SKILL_RETIREMENT_ACTING_WORKSPACES = WS;
      tables.links = [link('retired')];
      await GET(req());
      expect(inserts()).toHaveLength(1);
      expect(updates()).toHaveLength(0);
    });
  });
});
