/**
 * A spec's body artifact changes only through a spec revise, against real
 * Postgres. A generic artifact write (PATCH /api/artifacts/[id], MCP
 * update_artifact) used to land on it, bump the artifact's revision past the
 * one the spec head pins, and leave every later revise refused with the same
 * currentVersion forever.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { createSpecDraft, reviseSpecDraft } = await import('../../src/lib/specs/store');
const { reviseSpecSection } = await import('../../src/lib/specs/section-revise');
const { specIdForBodyArtifact } = await import('../../src/lib/specs/body-guard');
const { writeArtifactBody } = await import('../../src/lib/artifact-revisions');
const { redactArtifactText } = await import('@buildd/core/artifact-redaction');

const rand = () => Math.random().toString(36).slice(2, 10);
let wsA: string; let member: string;
beforeAll(async () => {
  assertDbConfigured();
  let teamA: string;
  ({ teamId: teamA, workspaceId: wsA } = await seedWorkspace());
  const [u] = await q<{ id: string }>(sql`INSERT INTO users (email) VALUES (${`u-${rand()}@example.test`}) RETURNING id`);
  await q(sql`INSERT INTO team_members (team_id, user_id, role) VALUES (${teamA}::uuid, ${u.id}::uuid, 'member')`);
  member = u.id;
});
const user = () => ({ kind: 'user' as const, userId: member });

const BODY = '# Checkout\nThe contract.\n\n## Currency\nR-1: Totals are in the shopper currency.\n';
async function draft(body = BODY) {
  const r = await createSpecDraft(user(), { workspaceId: wsA, title: `Checkout ${rand()}`, body });
  if (!r.ok) throw new Error(r.error);
  return r.spec;
}
const artifactRow = async (id: string) =>
  (await q<{ content: string; current_revision: number; title: string; metadata: unknown }>(sql`
    SELECT content, current_revision, title, metadata FROM artifacts WHERE id = ${id}::uuid`))[0];

describe('a spec body is recognised', () => {
  test('specIdForBodyArtifact names the spec, and nothing for an ordinary artifact', async () => {
    const spec = await draft();
    expect(await specIdForBodyArtifact(spec.bodyArtifactId)).toBe(spec.id);
    const [plain] = await q<{ id: string }>(sql`INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${wsA}::uuid, 'content', 't', 'x') RETURNING id`);
    expect(await specIdForBodyArtifact(plain.id)).toBeNull();
  });
});

describe('a generic body write cannot land on a spec body', () => {
  test('writeArtifactBody is refused, nothing is written, and the spec still revises', async () => {
    const spec = await draft();
    const before = await artifactRow(spec.bodyArtifactId);
    const w = await writeArtifactBody(spec.bodyArtifactId, { content: 'overwritten', author: 'account:x' }, { title: 'hijacked' });
    expect(w).toEqual({ ok: false, conflict: false, specBody: true, specId: spec.id });
    expect(await artifactRow(spec.bodyArtifactId)).toEqual(before);

    const next = BODY + '\n## Refunds\nR-2: Refunds go to the original card.\n';
    const r = await reviseSpecDraft(user(), spec.id, { expectedVersion: 1, body: next });
    if (!r.ok) throw new Error(r.error);
    expect(r.spec.version).toBe(2);
    const s = await reviseSpecSection(user(), spec.id, { expectedVersion: 2, heading: 'Refunds', body: '## Refunds\nR-2: Refunds go back to the card.\n' });
    if (!s.ok) throw new Error(s.error);
    expect(s.spec.version).toBe(3);
  });

  test('with expectedRevision too: refused as a spec body, not reported as a revision conflict', async () => {
    const spec = await draft();
    const { current_revision } = await artifactRow(spec.bodyArtifactId);
    const w = await writeArtifactBody(spec.bodyArtifactId, { content: 'x', expectedRevision: current_revision });
    expect(w.ok).toBe(false);
    expect((w as { specBody?: boolean }).specBody).toBe(true);
  });

  test('an ordinary artifact still writes', async () => {
    const [plain] = await q<{ id: string }>(sql`INSERT INTO artifacts (workspace_id, type, title, content) VALUES (${wsA}::uuid, 'content', 't', 'a') RETURNING id`);
    const w = await writeArtifactBody(plain.id, { content: 'b' });
    expect(w.ok).toBe(true);
  });
});

describe('a body moved outside revise is explained, not looped', () => {
  test('redaction removes the value from the spec body and its history; the next revise says why it is refused', async () => {
    const secret = `sk_live_${rand()}${rand()}`;
    const spec = await draft(`${BODY}\nKey: ${secret}\n`);
    const res = await redactArtifactText(secret, '[REDACTED]');
    expect(res.bodies).toBe(1);
    const row = await artifactRow(spec.bodyArtifactId);
    expect(row.content.includes(secret)).toBe(false);
    const [{ n }] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM artifact_revisions WHERE artifact_id = ${spec.bodyArtifactId}::uuid AND strpos(content, ${secret}) > 0`);
    expect(n).toBe(0);

    const r = await reviseSpecDraft(user(), spec.id, { expectedVersion: 1, body: BODY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.code).toBe('spec_body_moved');
    // No currentVersion: re-reading and revising at the same version would be refused again.
    expect(r.currentVersion).toBeUndefined();
    expect(r.error).toMatch(/outside a spec revise/);
    const [{ version }] = await q<{ version: number }>(sql`SELECT version FROM specs WHERE id = ${spec.id}::uuid`);
    expect(version).toBe(1);
  });
});
