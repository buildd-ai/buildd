/**
 * render_activity handler and the legacy-writer diversion (§12.1 rules 3, 5, 6).
 * The SQL is rendered with PgDialect; the GitHub comment store is faked.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ACTIVITY_COMMENT_MARKER } from '@/lib/pr-activity-comment';
import { activityNoteKey, activityNotesSql, divertActivityNote, divertNoteSql, kernelDeliveryForActivitySql, renderActivityEffect, transitionsSql } from './pr-activity-effects';
import { renderVersionMarker } from './pr-activity-render';
import type { ClaimedEffect } from './effects';
import type { Exec } from './kernel';

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;

const deliveryRow = (version: number, o: Record<string, unknown> = {}) => ({
  id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/widgets', pr_number: 7, base_ref: 'dev',
  state: 'MERGED', state_reason: null, version, current_head_sha: 'H2', current_round: 1, max_rounds: 3,
  approved_heads: ['H2'], composition_heads: [], authority: 'kernel', ...o,
});

function fakeExec(versions: number[], o: { authority?: string } = {}) {
  const calls: string[] = [];
  let loads = 0;
  const exec: Exec = async (q) => {
    const t = text(q);
    calls.push(t.split('\n')[0]);
    if (t.includes('workflow:load_view')) {
      const v = versions[Math.min(loads++, versions.length - 1)];
      return { rows: [{ delivery: deliveryRow(v, o.authority ? { authority: o.authority } : {}), rounds: [], attempts: [] }] };
    }
    if (t.includes('workflow:activity_transitions')) {
      return { rows: [{ command: 'PrMerged', from_state: 'APPROVED', to_state: 'MERGED', to_version: versions[0], evidence: {}, created_at: '2026-10-06T10:00:00Z' }] };
    }
    if (t.includes('workflow:activity_notes')) return { rows: [] };
    return { rows: [] };
  };
  return { exec, calls };
}

function fakeGithub(existing: Array<{ id: number; body: string }>) {
  const store = new Map(existing.map((c) => [c.id, c.body]));
  const ops: string[] = [];
  let next = 100;
  const api = async (_i: number, path: string, opts?: RequestInit): Promise<unknown> => {
    const method = opts?.method ?? 'GET';
    if (method === 'GET') return [...store.entries()].map(([id, body]) => ({ id, body }));
    const m = /comments\/(\d+)$/.exec(path);
    if (method === 'DELETE' && m) { store.delete(Number(m[1])); ops.push(`DELETE ${m[1]}`); return null; }
    if (method === 'PATCH' && m) { store.set(Number(m[1]), JSON.parse(String(opts!.body)).body); ops.push(`PATCH ${m[1]}`); return null; }
    if (method === 'POST') { const id = next++; store.set(id, JSON.parse(String(opts!.body)).body); ops.push(`POST ${id}`); return { id }; }
    return null;
  };
  return { api, store, ops };
}

const effect: ClaimedEffect = {
  id: 'e1', deliveryId: 'd1', transitionId: 'tr1', kind: 'render_activity', dedupeKey: 'render:d1:5', payload: {}, attemptCount: 1,
  delivery: { state: 'MERGED', version: 5 }, transition: { toState: 'MERGED', toVersion: 5 },
};
const deps = (exec: Exec, api: unknown) => ({
  exec, github: api as never, repoFor: async () => ({ installationId: 1, repoFullName: 'acme/widgets', gitConfig: null }), timezone: async () => 'UTC',
});

describe('render_activity handler', () => {
  test('creates the comment when none exists (rule 6)', async () => {
    const { exec } = fakeExec([5, 5]);
    const gh = fakeGithub([]);
    const r = await renderActivityEffect(effect, deps(exec, gh.api));
    expect(r.outcome).toBe('ok:created');
    const body = [...gh.store.values()][0];
    expect(body).toContain(ACTIVITY_COMMENT_MARKER);
    expect(body).toContain('**Merged**');
    expect(body).toContain(renderVersionMarker(5));
  });

  test('keeps the oldest of duplicate comments and deletes the rest (rule 5)', async () => {
    const { exec } = fakeExec([5, 5]);
    const gh = fakeGithub([{ id: 2, body: `${ACTIVITY_COMMENT_MARKER}\nold` }, { id: 9, body: `${ACTIVITY_COMMENT_MARKER}\ndup` }]);
    await renderActivityEffect(effect, deps(exec, gh.api));
    expect(gh.ops).toEqual(['DELETE 9', 'PATCH 2']);
    expect([...gh.store.keys()]).toEqual([2]);
  });

  test('a render older than the marker on GitHub is skipped (rule 3)', async () => {
    const { exec } = fakeExec([5, 5]);
    const gh = fakeGithub([{ id: 2, body: `${ACTIVITY_COMMENT_MARKER}\nnewer\n${renderVersionMarker(8)}` }]);
    expect((await renderActivityEffect(effect, deps(exec, gh.api))).outcome).toBe('skipped:older_version');
    expect(gh.ops).toEqual([]);
  });

  test('re-rendering the same version is a no-op', async () => {
    const { exec } = fakeExec([5, 5, 5, 5]);
    const gh = fakeGithub([]);
    await renderActivityEffect(effect, deps(exec, gh.api));
    expect((await renderActivityEffect(effect, deps(exec, gh.api))).outcome).toBe('ok:unchanged');
  });

  test('owes a follow-up render when the version advanced while writing (rule 3)', async () => {
    const { exec, calls } = fakeExec([5, 6]);
    const gh = fakeGithub([]);
    const r = await renderActivityEffect(effect, deps(exec, gh.api));
    expect(r.outcome).toBe('ok:created+followup');
    expect(calls).toContain('-- workflow:followup_effect');
  });

  test('a delivery released to legacy is not rendered by the kernel', async () => {
    const { exec } = fakeExec([5], { authority: 'legacy' });
    const gh = fakeGithub([]);
    expect((await renderActivityEffect(effect, deps(exec, gh.api))).outcome).toBe('skipped:legacy_owns');
    expect(gh.ops).toEqual([]);
  });
});

describe('legacy writer diversion', () => {
  test('a kernel-owned PR records the note as a fact and owes one render', async () => {
    const seen: string[] = [];
    const exec: Exec = async (q) => {
      const t = text(q);
      seen.push(t);
      if (t.includes('workflow:activity_delivery')) return { rows: [{ id: 'd1', workspace_id: 'w1' }] };
      return { rows: [{ facts: 1, effects: 1 }] };
    };
    const id = await divertActivityNote({ workspaceId: 'w1', repoFullName: 'acme/widgets', prNumber: 7, entry: { kind: 'ci_fixing', iteration: 1 } }, exec);
    expect(id).toBe('d1');
    expect(seen[0]).toContain("authority = 'kernel'");
    expect(seen[1]).toContain("'activity_note'");
    expect(seen[1]).toContain('ON CONFLICT (workspace_id, fact_key) DO NOTHING');
    expect(seen[1]).toContain("'render_activity'");
  });

  test('a legacy-owned PR is not diverted', async () => {
    const exec: Exec = async () => ({ rows: [] });
    expect(await divertActivityNote({ repoFullName: 'acme/widgets', prNumber: 7, entry: { kind: 'ci_fixing' } }, exec)).toBeNull();
  });

  test('the note key ignores the timestamp, so a redelivery dedupes', () => {
    expect(activityNoteKey('d1', { kind: 'ci_fixing', iteration: 1, at: '2026-10-06T00:00:00Z' }))
      .toBe(activityNoteKey('d1', { kind: 'ci_fixing', iteration: 1, at: '2026-10-07T00:00:00Z' }));
    expect(activityNoteKey('d1', { kind: 'ci_fixing', iteration: 1 })).not.toBe(activityNoteKey('d1', { kind: 'ci_fixing', iteration: 2 }));
    expect(text(divertNoteSql({ deliveryId: 'd1', workspaceId: 'w1', repoFullName: 'r', prNumber: 1, entry: { kind: 'lede_corrected' } }))).toContain('FROM f, LATERAL');
  });
});

describe('read SQL renders through PgDialect', () => {
  test('transitions: the whole log of one delivery, in version order', () => {
    const q = dialect.sqlToQuery(transitionsSql('d1'));
    expect(q.sql).toContain('FROM workflow_transitions');
    expect(q.sql).toContain('ORDER BY');
    expect(q.params).toContain('d1');
  });
  test("activity notes: only this delivery's activity_note facts", () => {
    const q = dialect.sqlToQuery(activityNotesSql('d1'));
    expect(q.sql).toContain('FROM workflow_facts');
    expect(q.sql + JSON.stringify(q.params)).toContain('activity_note');
    expect(q.params).toContain('d1');
  });
  test('kernel delivery lookup: kernel authority only, scoped by repo and PR (and workspace when given)', () => {
    const scoped = dialect.sqlToQuery(kernelDeliveryForActivitySql({ workspaceId: 'w1', repoFullName: 'acme/r', prNumber: 7 }));
    expect(scoped.sql).toContain("authority = 'kernel'");
    expect(scoped.params).toEqual(expect.arrayContaining(['w1', 'acme/r', 7]));
    const bare = dialect.sqlToQuery(kernelDeliveryForActivitySql({ repoFullName: 'acme/r', prNumber: 7 }));
    expect(bare.params).not.toContain('w1');
  });
});
