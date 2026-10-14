/**
 * Living Specs Slice 13 (R-61..R-65), against real Postgres: the spec page's
 * Delivery and verification entries are derived from task pins (and mission
 * outcome-spec selections), each listed once; delivery and the current
 * standing are kept apart; a text mention makes no entry; nothing from another
 * workspace or beyond the reader's access shows; and reading changes nothing.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision } = await import('../../src/lib/specs/approval');
const { pinSpecSource } = await import('../../src/lib/specs/pin');
const { recordSpecVerdict } = await import('../../src/lib/specs/outcome');
const { readSpecDelivery } = await import('../../src/lib/specs/delivery');

const rand = () => Math.random().toString(36).slice(2, 10);
const HEAD = 'a'.repeat(40);

async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}
const user = (userId: string) => ({ kind: 'user' as const, userId });

let teamA: string; let wsA: string; let teamB: string; let wsB: string; let admin: string; let outsider: string;
beforeAll(async () => {
  assertDbConfigured();
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  await q(sql`UPDATE workspaces SET access_mode = 'open' WHERE id = ${wsA}::uuid`);
  ({ teamId: teamB, workspaceId: wsB } = await seedWorkspace());
  admin = await person(teamA, 'admin');
  outsider = await person(teamB, 'admin');
});

const BODY = '# Checkout\n- R-1: Totals are in the shopper\'s currency.\n- AC-1: A EUR cart shows the euro sign.\n';

async function approvedSpec() {
  const d = await createSpecDraft(user(admin), { workspaceId: wsA, title: `Checkout ${rand()}`, body: BODY });
  if (!d.ok) throw new Error(d.error);
  const a = await approveSpecRevision(user(admin), d.spec.id, { revision: 1, expectedVersion: 1 });
  if (!a.ok) throw new Error(a.error);
  return { specId: d.spec.id, version: a.spec.version };
}

async function approveNext(specId: string, version: number, extra: string) {
  const r = await reviseSpecDraft(user(admin), specId, { expectedVersion: version, body: BODY + extra });
  if (!r.ok) throw new Error(r.error);
  const a = await approveSpecRevision(user(admin), specId, { revision: r.revision.revision, expectedVersion: r.spec.version });
  if (!a.ok) throw new Error(a.error);
  return a.spec.version;
}

/** A completed task pinned to the spec's approved revision, with a merged PR delivery at HEAD. */
async function pinnedTask(specId: string, opts: { workspaceId?: string; missionId?: string | null; merged?: boolean; title?: string } = {}) {
  const ws = opts.workspaceId ?? wsA;
  const pinned = await pinSpecSource(wsA, { specSource: { specId } });
  if (!pinned.ok) throw new Error(pinned.error);
  const [t] = await q<{ id: string }>(sql`
    INSERT INTO tasks (workspace_id, title, status, context, mission_id)
    VALUES (${ws}::uuid, ${opts.title ?? `build ${rand()}`}, 'completed', ${JSON.stringify(pinned.context)}::jsonb, ${opts.missionId ?? null}::uuid) RETURNING id`);
  const [d] = await q<{ id: string }>(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority, current_head_sha, merged_at)
    VALUES (${ws}::uuid, ${t.id}::uuid, ${opts.merged === false ? 'OPEN' : 'MERGED'}, 'kernel', ${HEAD}, ${opts.merged === false ? null : new Date().toISOString()}::timestamptz) RETURNING id`);
  return { taskId: t.id, deliveryId: d.id, context: pinned.context };
}

const read = async (specId: string, userId = admin, opts: { limit?: number; cursor?: string | null } = {}) => readSpecDelivery(user(userId), specId, opts);

describe('entries come from pins, each once (R-61, R-62, AC-45)', () => {
  test('a pinned task lists once; its retry attempt and review round add nothing', async () => {
    const { specId } = await approvedSpec();
    const t = await pinnedTask(specId);
    // A retry attempt and a review round carry the parent's pin.
    await q(sql`INSERT INTO tasks (workspace_id, title, status, context, parent_task_id, task_class)
      VALUES (${wsA}::uuid, 'retry', 'completed', ${JSON.stringify(t.context)}::jsonb, ${t.taskId}::uuid, 'attempt')`);
    await q(sql`INSERT INTO tasks (workspace_id, title, status, context, parent_task_id, task_class, delivery_id, delivery_role)
      VALUES (${wsA}::uuid, '[reviewer] PR #1', 'completed', ${JSON.stringify(t.context)}::jsonb, ${t.taskId}::uuid, 'work', ${t.deliveryId}::uuid, 'review')`);
    const r = await read(specId);
    expect(r?.entries.map((e) => e.id)).toEqual([t.taskId]);
    expect(r?.entries[0].href).toBe(`/app/tasks/${t.taskId}`);
    expect(r?.entries[0].kind).toBe('task');
  });

  test('a task in a mission that selected the spec is listed under the mission, not again on its own', async () => {
    const { specId } = await approvedSpec();
    const [m] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title, goal_criteria)
      VALUES (${teamA}::uuid, ${wsA}::uuid, ${`m-${rand()}`}, ${JSON.stringify([{ type: 'living_spec', specId, revision: 1 }])}::jsonb) RETURNING id`);
    const inMission = await pinnedTask(specId, { missionId: m.id });
    const direct = await pinnedTask(specId);
    const ids = (await read(specId))!.entries.filter((e) => e.kind === 'task').map((e) => e.id);
    expect(ids).toContain(direct.taskId);
    expect(ids).not.toContain(inMission.taskId);
  });

  test('a task in a mission that did not select the spec still lists, as itself', async () => {
    const { specId } = await approvedSpec();
    const [m] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title) VALUES (${teamA}::uuid, ${wsA}::uuid, ${`m-${rand()}`}) RETURNING id`);
    const t = await pinnedTask(specId, { missionId: m.id });
    expect((await read(specId))!.entries.map((e) => e.id)).toEqual([t.taskId]);
  });

  test('pages newest first with a cursor, never repeating an entry', async () => {
    const { specId } = await approvedSpec();
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push((await pinnedTask(specId)).taskId);
    const p1 = await read(specId, admin, { limit: 2 });
    expect(p1!.entries).toHaveLength(2);
    expect(p1!.next).not.toBeNull();
    const p2 = await read(specId, admin, { limit: 2, cursor: p1!.next });
    expect(p2!.next).toBeNull();
    const all = [...p1!.entries, ...p2!.entries].map((e) => e.id);
    expect(new Set(all).size).toBe(3);
    expect(all.sort()).toEqual([...made].sort());
  });
});

describe('delivery and standing are kept apart (R-63, AC-46)', () => {
  test('verified on revision 1, then revision 2 approved: delivered on 1, not verified yet against 2', async () => {
    const { specId, version } = await approvedSpec();
    const t = await pinnedTask(specId);
    for (const criterionId of ['R-1', 'AC-1']) {
      const v = await recordSpecVerdict(user(admin), t.taskId, { criterionId, verdict: 'pass', headSha: HEAD, evidenceRefs: [{ kind: 'ci', ref: 'https://example.test/run/1' }] });
      if (!v.ok) throw new Error(v.error);
    }
    let e = (await read(specId))!.entries[0];
    expect(e.standing).toEqual({ tone: 'success', text: 'Verified against revision 1.' });
    expect(e.deliveredText).toBe('Built to revision 1 and delivered.');
    expect(e.criteria.map((c) => [c.criterionId, c.mark])).toEqual([['R-1', 'pass'], ['AC-1', 'pass']]);
    expect(e.criteria[0].evidence).toEqual([{ label: 'ci', href: 'https://example.test/run/1' }]);

    await approveNext(specId, version, '- AC-2: A USD cart shows the dollar sign.\n');
    e = (await read(specId))!.entries[0];
    expect(e.builtTo).toBe(1);
    expect(e.delivered).toBe(true);
    expect(e.standing).toEqual({ tone: 'muted', text: 'Not verified yet against revision 2.' });
  });

  test('a failing criterion reads fails; an unmerged PR reads not delivered yet; a merged PR alone is not a pass', async () => {
    const { specId } = await approvedSpec();
    const failing = await pinnedTask(specId);
    const v = await recordSpecVerdict(user(admin), failing.taskId, { criterionId: 'AC-1', verdict: 'fail', headSha: HEAD });
    if (!v.ok) throw new Error(v.error);
    const open = await pinnedTask(specId, { merged: false });
    const silent = await pinnedTask(specId);
    const by = new Map((await read(specId))!.entries.map((e) => [e.id, e]));
    expect(by.get(failing.taskId)!.standing).toEqual({ tone: 'error', text: 'AC-1 fails against revision 1.' });
    expect(by.get(open.taskId)!.deliveredText).toBe('Built to revision 1, not delivered yet.');
    expect(by.get(silent.taskId)!.delivered).toBe(true);
    expect(by.get(silent.taskId)!.standing.text).toBe('Not verified yet against revision 1.');
  });

  test('a pass on an older commit is not verified', async () => {
    const { specId } = await approvedSpec();
    const t = await pinnedTask(specId);
    for (const criterionId of ['R-1', 'AC-1']) await recordSpecVerdict(user(admin), t.taskId, { criterionId, verdict: 'pass', headSha: HEAD });
    await q(sql`UPDATE workflow_deliveries SET current_head_sha = ${'b'.repeat(40)} WHERE id = ${t.deliveryId}::uuid`);
    const e = (await read(specId))!.entries[0];
    expect(e.standing.text).toBe('Passed on an older commit. Not verified yet against revision 1.');
    expect(e.criteria.every((c) => c.mark === 'stale')).toBe(true);
  });
});

describe('only real links, only what the reader may see (AC-47, R-65)', () => {
  test('a text mention of the spec makes no entry, and the spec body is never changed', async () => {
    const { specId } = await approvedSpec();
    await q(sql`INSERT INTO tasks (workspace_id, title, description, status, context)
      VALUES (${wsA}::uuid, ${`mentions ${specId}`}, ${`See /app/specs/${specId}`}, 'completed', ${JSON.stringify({ note: specId })}::jsonb)`);
    const before = await q<{ head_revision: number; version: number }>(sql`SELECT head_revision, version FROM specs WHERE id = ${specId}::uuid`);
    expect((await read(specId))!.entries).toEqual([]);
    const after = await q<{ head_revision: number; version: number }>(sql`SELECT head_revision, version FROM specs WHERE id = ${specId}::uuid`);
    expect(after).toEqual(before);
  });

  test('a task in another workspace naming the spec is not listed, and a reader outside the workspace gets nothing', async () => {
    const { specId } = await approvedSpec();
    const own = await pinnedTask(specId);
    await pinnedTask(specId, { workspaceId: wsB });
    expect((await read(specId))!.entries.map((e) => e.id)).toEqual([own.taskId]);
    expect(await read(specId, outsider)).toBeNull();
  });

  test('reading changes no task or delivery state', async () => {
    const { specId } = await approvedSpec();
    const t = await pinnedTask(specId);
    const snap = () => q(sql`SELECT t.status, t.updated_at, d.state, d.version FROM tasks t JOIN workflow_deliveries d ON d.owner_task_id = t.id WHERE t.id = ${t.taskId}::uuid`);
    const before = await snap();
    await read(specId);
    expect(await snap()).toEqual(before);
  });
});
