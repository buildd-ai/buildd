/**
 * What the visual-review scheduler decides for each kind of mission, on a real
 * database (Living Spec "Fast at any size", R-25). The cron sweep reads its
 * missions' facts in batches; the single-mission door (`scheduleMissionVisualReview`,
 * called when a merge is refused for an owed review) reads them itself. Both
 * must reach the same plan for every case the scheduler knows: nothing to do
 * (and why), restamp a queued audit, wait out a backoff, file the review
 * (first, retry, with or without a browser runner), and each blocked cause.
 *
 * The scenarios are seeded fresh in their own workspaces; GitHub is never
 * reached (no workspace has a repo link, so the branch diff is unreadable and
 * the classifier fails safe to review_required, as it does in production).
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q } from './harness';

assertDbConfigured();

mock.module('server-only', () => ({}));
// Filing an audit wakes it for a runner: a write outside the scheduler's decision.
const dispatch = await import('../../src/lib/dispatch-authority');
mock.module('../../src/lib/dispatch-authority', () => ({ ...dispatch, announceTaskCreated: async () => {}, wakeTask: async () => {} }));
mock.module('@/lib/dispatch-authority', () => ({ ...dispatch, announceTaskCreated: async () => {}, wakeTask: async () => {} }));

const { scheduleMissionVisualReview, sweepVisualReviewSchedule } = await import('../../src/lib/workflow/visual-review-schedule-run');

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OLD = 'ffffeeeeddddccccbbbbaaaa9999888877776666';
const HOUR = 3_600_000;

let teamId: string;
const uniq = () => Math.random().toString(36).slice(2, 10);

async function workspace(gitConfig: Record<string, unknown> | null = null): Promise<string> {
  const [ws] = await q<{ id: string }>(sql`
    INSERT INTO workspaces (name, team_id, git_config) VALUES (${`vrs-${uniq()}`}, ${teamId}::uuid, ${gitConfig ? JSON.stringify(gitConfig) : null}::jsonb)
    RETURNING id`);
  return ws.id;
}

interface AuditSeed { status: string; headSha: string | null; updatedAgoMs?: number; result?: Record<string, unknown>; round?: number }

interface Scenario {
  name: string;
  gitConfig?: Record<string, unknown> | null;
  autoSurfaceAudit?: boolean | null;
  executor?: 'runner' | 'local';
  builderStatus?: string;
  delivery?: boolean;
  audits?: AuditSeed[];
  waiver?: boolean;
  expected: Record<string, unknown>;
}

async function seedScenario(s: Scenario, now: number): Promise<string> {
  const ws = await workspace(s.gitConfig ?? null);
  const pr = 4000 + Math.floor(Math.random() * 100000);
  const [m] = await q<{ id: string }>(sql`
    INSERT INTO missions (team_id, workspace_id, title, status, primary_pr_number, working_branch, auto_surface_audit, executor)
    VALUES (${teamId}::uuid, ${ws}::uuid, ${`Mission ${s.name}`}, 'active', ${pr}, ${`buildd/mission-${uniq()}`},
      ${s.autoSurfaceAudit ?? true}, ${s.executor ?? 'runner'})
    RETURNING id`);
  const [builder] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, mission_id, title, status, path_manifest, context)
    VALUES (${ws}::uuid, ${m.id}::uuid, 'Build the settings card', ${s.builderStatus ?? 'completed'},
      ${JSON.stringify(['apps/web/src/app/app/(protected)/settings/page.tsx'])}::jsonb,
      ${JSON.stringify({ notes: 'x'.repeat(2000) })}::jsonb)
    RETURNING id`);
  if (s.delivery !== false) {
    await q(sql`
      INSERT INTO workflow_deliveries (workspace_id, owner_task_id, pr_number, base_ref, state, current_head_sha)
      VALUES (${ws}::uuid, ${builder.id}::uuid, ${pr}, 'dev', 'OPEN', ${HEAD})`);
  }
  let i = 0;
  for (const a of s.audits ?? []) {
    i++;
    const at = new Date(now - (a.updatedAgoMs ?? 2 * HOUR) - i * 1000).toISOString();
    await q(sql`
      INSERT INTO tasks (workspace_id, mission_id, title, status, role_slug, context, result, created_at, updated_at)
      VALUES (${ws}::uuid, ${m.id}::uuid, ${`[surface audit] Mission ${s.name}`}, ${a.status}, 'visual-auditor',
        ${JSON.stringify({ surfaceAuditTrigger: 'auto', ...(a.round ? { surfaceAuditRound: a.round } : {}), ...(a.headSha ? { visualReview: { headSha: a.headSha, reason: 'first', attempt: 1 } } : {}) })}::jsonb,
        ${a.result ? JSON.stringify(a.result) : null}::jsonb, ${at}::timestamptz, ${at}::timestamptz)`);
  }
  if (s.waiver) {
    await q(sql`
      INSERT INTO mission_notes (mission_id, author_type, type, title, body)
      VALUES (${m.id}::uuid, 'user', 'decision', 'Surface audit waived', 'Copy-only change, checked by hand.')`);
  }
  return m.id;
}

const failed = (agoMs: number, result?: Record<string, unknown>): AuditSeed => ({ status: 'failed', headSha: HEAD, updatedAgoMs: agoMs, result });

/** Every plan the scheduler can reach, each with the answer it gives today. */
const SCENARIOS: Scenario[] = [
  { name: 'policy off', autoSurfaceAudit: false, expected: { action: 'none', why: 'policy_off' } },
  { name: 'ask policy', gitConfig: { visualReview: { policy: 'ask' } }, expected: { action: 'none', why: 'ask_policy' } },
  { name: 'work not landed', builderStatus: 'in_progress', expected: { action: 'none', why: 'work_not_landed' } },
  { name: 'waived, work not landed', builderStatus: 'in_progress', waiver: true, expected: { action: 'none', why: 'waived' } },
  { name: 'waived', waiver: true, expected: { action: 'none', why: 'waived' } },
  { name: 'no integration head', delivery: false, expected: { action: 'none', why: 'no_integration_head' } },
  { name: 'first review', expected: { action: 'enqueue', headSha: HEAD, round: 1, reason: 'first', attempt: 1, runnerNote: 'no_browser_runner' } },
  { name: 'queued audit on an older head', audits: [{ status: 'pending', headSha: OLD }], expected: { action: 'restamp', headSha: HEAD } },
  { name: 'running audit', audits: [{ status: 'in_progress', headSha: HEAD }], expected: { action: 'none', why: 'audit_live' } },
  { name: 'backing off', audits: [failed(60_000)], expected: { action: 'wait', attempt: 2 } },
  { name: 'retry after backoff', audits: [failed(2 * HOUR)], expected: { action: 'enqueue', headSha: HEAD, round: 1, reason: 'retry', attempt: 2, runnerNote: 'no_browser_runner' } },
  { name: 'retries exhausted', audits: [failed(2 * HOUR), failed(3 * HOUR), failed(4 * HOUR)], expected: { action: 'blocked', cause: 'retries_exhausted', nextActor: 'owner' } },
  { name: 'capture config', audits: [failed(2 * HOUR, { error: 'capture refused: protection_bypass_missing' })], expected: { action: 'blocked', cause: 'capture_config', nextActor: 'owner' } },
  { name: 'local executor', executor: 'local', expected: { action: 'blocked', cause: 'executor_local', nextActor: 'owner' } },
  { name: 'cancelled on this head', audits: [{ status: 'cancelled', headSha: HEAD }], expected: { action: 'blocked', cause: 'audit_cancelled', nextActor: 'owner' } },
  { name: 'rereview cap', audits: [5, 4, 3, 2, 1].map(round => ({ status: 'cancelled', headSha: OLD, round })), expected: { action: 'blocked', cause: 'rereview_cap', nextActor: 'owner' } },
];

let now: number;
const ids = new Map<string, string>();
const workspaceIds: string[] = [];

beforeAll(async () => {
  const [team] = await q<{ id: string }>(sql`INSERT INTO teams (name, slug) VALUES ('Visual review plans', ${`vrs-plans-${uniq()}`}) RETURNING id`);
  teamId = team.id;
  now = Date.now();
  for (const s of SCENARIOS) ids.set(s.name, await seedScenario(s, now));
  for (const r of await q<{ workspace_id: string }>(sql`SELECT workspace_id FROM missions WHERE team_id = ${teamId}::uuid`)) workspaceIds.push(r.workspace_id);
}, 120_000);

describe('visual-review scheduler: every plan, through the sweep and through the single-mission door', () => {
  it('the sweep reaches the same plan as it always has for each case', async () => {
    const { outcomes } = await sweepVisualReviewSchedule(now, 500, { workspaceIds });
    const byMission = new Map(outcomes.map(o => [o.missionId, o.plan]));
    for (const s of SCENARIOS) {
      expect({ name: s.name, plan: byMission.get(ids.get(s.name)!) }).toMatchObject({ name: s.name, plan: s.expected });
    }
  }, 120_000);

  it('the single-mission door reaches the same plan (after the sweep acted, filed reviews are live)', async () => {
    for (const s of SCENARIOS) {
      const o = await scheduleMissionVisualReview(ids.get(s.name)!, now);
      const expected = s.expected.action === 'enqueue' ? { action: 'none', why: 'audit_live' }
        : s.expected.action === 'restamp' ? { action: 'none', why: 'audit_live' }
        : s.expected;
      expect({ name: s.name, plan: o?.plan }).toMatchObject({ name: s.name, plan: expected });
    }
  }, 120_000);

  it('a restamped audit carries the new head and a filed one is stamped for it', async () => {
    const rows = await q<{ mission_id: string; status: string; head: string | null }>(sql`
      SELECT mission_id, status, context->'visualReview'->>'headSha' AS head FROM tasks
      WHERE mission_id IN (${sql.join([ids.get('queued audit on an older head')!, ids.get('first review')!, ids.get('retry after backoff')!].map(id => sql`${id}::uuid`), sql`, `)})
        AND title LIKE '[surface audit]%' AND status = 'pending'`);
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.head).toBe(HEAD);
  });

  it('a run takes a bounded batch and the next starts after it, so every mission is reached in turn', async () => {
    const all = SCENARIOS.length;
    const seen = new Set<string>();
    let after: string | null = null;
    for (let i = 0; i < Math.ceil(all / 5); i++) {
      const { outcomes, cursor } = await sweepVisualReviewSchedule(now, 5, { after, workspaceIds });
      expect(outcomes.length).toBe(5);
      for (const o of outcomes) seen.add(o.missionId);
      after = cursor;
    }
    expect(seen.size).toBe(all);
    // A batch that holds every candidate leaves no cursor: the next run starts from the top.
    expect((await sweepVisualReviewSchedule(now, all + 1, { workspaceIds })).cursor).toBeNull();
  }, 120_000);
});
