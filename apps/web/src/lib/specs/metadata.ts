import { db } from '@buildd/core/db';
import { specMetadataChanges, specs, type SpecMetadataBlock } from '@buildd/core/db/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { author, fail, reach, type SpecCaller, type SpecError, type SpecRow } from './store';
import { specApprovalDeps } from './approval';

/**
 * A spec's metadata block (docs/specs/living-specs.md §18, R-14, R-31): the
 * mechanical fields of its repo copy (`verified_by`, `surfaces`,
 * `last_verified`, `assertions`, `owner`), kept outside every revision.
 *
 * Anyone with write access to the workspace's specs changes it, an agent or CI
 * included, with a reason. One statement writes the block (only while it is
 * still what the writer read) and one change row per field with who, why and
 * the previous value. It never writes a spec revision, so the version, the
 * approved revision and its content hash do not move (AC-93). An approved spec
 * in a workspace that opted in gets its generated PR updated (R-15).
 */

export const METADATA_KEYS = ['owner', 'last_verified', 'surfaces', 'verified_by', 'assertions'] as const;
type Key = (typeof METADATA_KEYS)[number];

const PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./[\]@+-]+$/;

function parseField(key: Key, raw: unknown): { value: SpecMetadataBlock[Key] | null } | { error: string } {
  if (raw === null) return { value: null };
  switch (key) {
    case 'owner':
      return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(raw) ? { value: raw } : { error: 'owner is a GitHub handle, without @' };
    case 'last_verified':
      return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw)) ? { value: raw } : { error: 'last_verified is a date, YYYY-MM-DD' };
    case 'surfaces':
    case 'verified_by': {
      if (!Array.isArray(raw) || raw.length > 50 || !raw.every((p) => typeof p === 'string' && PATH.test(p))) return { error: `${key} is a list of repo-relative paths` };
      return { value: [...new Set(raw as string[])] };
    }
    case 'assertions': {
      const ok = Array.isArray(raw) && raw.length <= 50 && raw.every((a) => a && typeof a === 'object' && !Array.isArray(a)
        && Object.keys(a).length > 0 && Object.entries(a).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v) && !String(v).includes('\n')));
      return ok ? { value: raw as SpecMetadataBlock['assertions'] } : { error: 'assertions is a list of flat objects of one-line strings, numbers or booleans' };
    }
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface MetadataChangeView {
  field: string;
  previousValue: unknown;
  newValue: unknown;
  reason: string;
  changedByKind: 'user' | 'agent';
  changedBy: string;
  createdAt: string;
}

/**
 * Change fields of a spec's metadata block. `changes` names each field to set
 * (null clears it); `reason` says why.
 */
export async function updateSpecMetadata(caller: SpecCaller, specId: string, input: { changes: unknown; reason: unknown }): Promise<{ ok: true; spec: SpecRow; changed: string[] } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500) return fail(400, 'reason (why the metadata changes, 3-500 characters) is required');
  const raw = input.changes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, `changes is an object of fields to set: ${METADATA_KEYS.join(', ')}`);
  const unknown = Object.keys(raw).filter((k) => !(METADATA_KEYS as readonly string[]).includes(k));
  if (unknown.length) return fail(400, `not a metadata field: ${unknown.join(', ')} (fields: ${METADATA_KEYS.join(', ')}; domain comes from the spec's area)`);
  const parsed: Partial<Record<Key, SpecMetadataBlock[Key] | null>> = {};
  for (const [k, v] of Object.entries(raw)) {
    const r = parseField(k as Key, v);
    if ('error' in r) return fail(400, r.error);
    parsed[k as Key] = r.value;
  }
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, true))) return fail(404, 'Spec not found');

  const before: SpecMetadataBlock = spec.metadata ?? {};
  const next: SpecMetadataBlock = { ...before };
  const changes: Array<{ field: Key; previous: unknown; value: unknown }> = [];
  for (const [k, v] of Object.entries(parsed) as Array<[Key, SpecMetadataBlock[Key] | null]>) {
    if (same(before[k], v)) continue;
    changes.push({ field: k, previous: before[k] ?? null, value: v });
    if (v === null) delete next[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  if (!changes.length) return { ok: true, spec, changed: [] };

  const who = author(caller);
  const reason = input.reason.trim();
  const rowsJson = JSON.stringify(changes.map((c) => ({ field: c.field, previous_value: c.previous, new_value: c.value })));
  // One statement: the block moves only while it is what we read, and the
  // change rows ride with it, so a racing writer cannot lose a previous value.
  const res = await db.execute(sql`
    WITH up AS (
      UPDATE specs SET metadata = ${JSON.stringify(next)}::jsonb, updated_at = now()
      WHERE id = ${specId}::uuid AND coalesce(metadata, '{}'::jsonb) = ${JSON.stringify(before)}::jsonb
      RETURNING id, workspace_id
    )
    INSERT INTO spec_metadata_changes (workspace_id, spec_id, field, previous_value, new_value, reason, changed_by_kind, changed_by)
    SELECT up.workspace_id, up.id, c.field, c.previous_value, c.new_value, ${reason}, ${who.authorKind}, ${who.label}
    FROM up, jsonb_to_recordset(${rowsJson}::jsonb) AS c(field text, previous_value jsonb, new_value jsonb)
    RETURNING id`);
  if ((((res as { rows?: unknown[] }).rows) ?? []).length === 0) {
    return fail(409, 'The metadata changed while you were writing it. Re-read it and try again.');
  }
  const [after] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (after.approvedRevision != null) {
    specApprovalDeps.afterResponse(async () => {
      const { fileSpecRepoCopy } = await import('./repo-copy');
      await fileSpecRepoCopy(specId);
    });
  }
  return { ok: true, spec: after, changed: changes.map((c) => c.field) };
}

/** The metadata change log, newest first. */
export async function listSpecMetadataChanges(caller: SpecCaller, specId: string, limit = 50): Promise<{ ok: true; metadata: SpecMetadataBlock; changes: MetadataChangeView[] } | SpecError> {
  if (!isUuid(specId)) return fail(404, 'Spec not found');
  const [spec] = await db.select().from(specs).where(eq(specs.id, specId)).limit(1);
  if (!spec || !(await reach(caller, spec.workspaceId, false))) return fail(404, 'Spec not found');
  const rows = await db.select().from(specMetadataChanges).where(eq(specMetadataChanges.specId, specId)).orderBy(desc(specMetadataChanges.createdAt)).limit(Math.min(Math.max(limit, 1), 200));
  return {
    ok: true,
    metadata: spec.metadata ?? {},
    changes: rows.map((r) => ({ field: r.field, previousValue: r.previousValue, newValue: r.newValue, reason: r.reason, changedByKind: r.changedByKind, changedBy: r.changedBy, createdAt: r.createdAt.toISOString() })),
  };
}
