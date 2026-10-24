/**
 * Opening Review is cheap (spec aafdec35, R-7 to R-10, AC-4, AC-5): against
 * real Postgres, on a spec with a 25 KB body and 12 revisions in a workspace
 * whose specs have a repo copy. The review path asks GitHub nothing (the repo
 * checks are their own request), and the page and the panel each stay inside
 * a round-trip budget, counted at the neon-http driver: one HTTP request per
 * statement, which is what a click pays in latency.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { neonConfig } from '@neondatabase/serverless';
import { assertDbConfigured, q, seedWorkspace } from './harness';

process.env.AUTH_SECRET ||= 'spec-review-speed-test-secret';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { approveSpecRevision, specApprovalDeps } = await import('../../src/lib/specs/approval');
const { specPageView, specRepoChecks, specReviewView } = await import('../../src/lib/specs/page-view');
const repoCopy = await import('../../src/lib/specs/repo-copy');
const { specKnowledgeDeps } = await import('../../src/lib/specs/knowledge');

const rand = () => Math.random().toString(36).slice(2, 10);
const user = (userId: string) => ({ kind: 'user' as const, userId });
async function person(teamId: string, role: 'owner' | 'admin' | 'member') {
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamId}::uuid, ${u.id}::uuid, ${role})`);
  return u.id;
}

/** Round trips to Postgres while `fn` runs. */
async function counted<T>(fn: () => Promise<T>): Promise<{ value: T; trips: number; ms: number }> {
  let trips = 0;
  neonConfig.fetchFunction = (url: string, init: RequestInit) => {
    trips++;
    // REVIEW_SPEED_TRACE=1 prints each statement, to see what a budget overrun is made of.
    if (process.env.REVIEW_SPEED_TRACE) process.stderr.write(`  ${trips}: ${String(JSON.parse(String(init.body)).query ?? 'batch').slice(0, 140)}\n`);
    // REVIEW_SPEED_LATENCY_MS=30 adds a hosted database's round trip to each, so the time printed shows the longest chain.
    const lag = Number(process.env.REVIEW_SPEED_LATENCY_MS ?? 0);
    return lag ? new Promise<Response>((done) => setTimeout(() => done(fetch(url, init)), lag)) : fetch(url, init);
  };
  const t0 = performance.now();
  try {
    const value = await fn();
    return { value, trips, ms: performance.now() - t0 };
  } finally {
    neonConfig.fetchFunction = undefined;
  }
}

/** A 25 KB body: sections of criteria, one sentence changed per revision. */
function body(rev: number): string {
  const parts = ['# Exports\n\nWhat the export writes.\n'];
  for (let s = 1; s <= 46; s++) {
    parts.push(`\n## Section ${s}\n\n`);
    for (let c = 1; c <= 5; c++) parts.push(`- R-${s * 10 + c}: The export writes file ${s}.${c} with every widget field it was asked for, in order${s === 3 && c === 1 ? ` (revision ${rev})` : ''}.\n`);
    parts.push(`\nSome prose about section ${s} that pads it out to a realistic length for a spec this size.\n`);
  }
  return parts.join('');
}

const github: string[] = [];
let admin: string; let member: string; let specId: string;

beforeAll(async () => {
  assertDbConfigured();
  const { teamId, workspaceId } = await seedWorkspace();
  await q(sql`UPDATE workspaces SET access_mode = 'open', git_config = coalesce(git_config, '{}'::jsonb) || ${JSON.stringify({ livingSpecs: { nativeSource: true } })}::jsonb WHERE id = ${workspaceId}::uuid`);
  admin = await person(teamId, 'admin');
  member = await person(teamId, 'member');
  specApprovalDeps.afterResponse = () => {};
  // Each revise indexes its draft after the response; not part of what a click pays.
  specKnowledgeDeps.afterResponse = () => {};
  // Any GitHub call the page makes is recorded, and answered as if the repo were there.
  Object.assign(repoCopy.defaultRepoCopyDeps, {
    api: async (_i: number, path: string) => { github.push(path); return {}; },
    repo: async () => ({ fullName: 'acme/app', installationId: 1 }),
  });

  const area = await createSpecDraft(user(member), { workspaceId, title: `Exports Area ${rand()}`, scope: 'domain', body: '# Area\nExports.\n' }, { duplicates: false });
  if (!area.ok) throw new Error(area.error);
  const r = await createSpecDraft(user(member), { workspaceId, title: `Exports ${rand()}`, parentSpecId: area.spec.id, body: body(1) }, { duplicates: false });
  if (!r.ok) throw new Error(r.error);
  specId = r.spec.id;
  expect(body(1).length).toBeGreaterThan(25_000);
  const a = await approveSpecRevision(user(admin), specId, { revision: 1, expectedVersion: 1 });
  if (!a.ok || 'pending' in a) throw new Error('approval failed');
  let version = a.spec.version;
  for (let n = 2; n <= 12; n++) {
    const v = await reviseSpecDraft(user(member), specId, { expectedVersion: version, body: body(n), changeSummary: `Revision ${n}` });
    if (!v.ok) throw new Error(v.error);
    version = v.spec.version;
  }
}, 120_000);

afterEach(() => { github.length = 0; });

describe('Review', () => {
  test('the page with the review open asks GitHub nothing and stays in budget', async () => {
    const { value: v, trips, ms } = await counted(() => specPageView(admin, specId, { review: true }));
    process.stderr.write(`[review-speed] specPageView review=1: ${trips} round trips, ${ms.toFixed(0)} ms\n`);
    if (v.state !== 'ok' || !v.review) throw new Error('expected a review');
    expect(v.review).toMatchObject({ revision: 12, replaces: 1, linesAdded: 1, linesRemoved: 1 });
    expect(v.review.body).toBe(body(12));
    expect(github).toEqual([]);
    expect(trips).toBeLessThanOrEqual(30);
  }, 60_000);

  test('the panel alone is a few round trips and the same panes', async () => {
    const page = await specPageView(admin, specId, { review: true });
    if (page.state !== 'ok' || !page.review) throw new Error('expected a review');
    const { value: r, trips, ms } = await counted(() => specReviewView(user(admin), specId));
    process.stderr.write(`[review-speed] specReviewView: ${trips} round trips, ${ms.toFixed(0)} ms\n`);
    if (!r.ok) throw new Error(r.error);
    expect(r.review).toEqual({ ...page.review, version: page.spec.version });
    expect(github).toEqual([]);
    // The spec, reach and the approver check (most of it), the two revisions, both bodies in one read, attachments, and the
    // two read-ledger rows (written after the response in a request, so they add no latency there).
    expect(trips).toBeLessThanOrEqual(13);
  }, 60_000);

  test('the page without the review is in budget too', async () => {
    const { value: v, trips, ms } = await counted(() => specPageView(admin, specId));
    process.stderr.write(`[review-speed] specPageView: ${trips} round trips, ${ms.toFixed(0)} ms\n`);
    expect(v.state === 'ok' && v.review).toBeNull();
    expect(trips).toBeLessThanOrEqual(26);
  }, 60_000);

  test('the repo checks are their own request, a bounded one (R-9)', async () => {
    const r = await specRepoChecks(user(admin), specId);
    if (!r.ok) throw new Error(r.error);
    expect(r.revision).toBe(12);
    // This fake answers every call with nothing, so the base commit is unread: a note, after one call.
    expect(r.preflight).toMatchObject({ state: 'ran' });
    expect(r.preflight?.state === 'ran' && r.preflight.checks[0].note).toContain('could not be read');
    expect(github).toEqual(['/graphql']);
    expect(await specRepoChecks(user(member), specId)).toMatchObject({ ok: false, status: 403 });
  }, 60_000);

  test('a person who may not approve gets no review from the panel', async () => {
    const r = await specReviewView(user(member), specId);
    expect(r).toMatchObject({ ok: false, status: 403 });
    const other = await specReviewView(user(admin), '00000000-0000-4000-8000-000000000000');
    expect(other).toMatchObject({ ok: false, status: 404 });
  }, 60_000);
});
