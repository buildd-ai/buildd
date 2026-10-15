import { db } from '@buildd/core/db';
import { specMetadataChanges, specs, type SpecMetadataBlock } from '@buildd/core/db/schema';
import { and, desc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { author, fail, reach, type SpecCaller, type SpecError, type SpecRow } from './store';
import { specApprovalDeps } from './approval';
import { AREA_GONE_STATUSES } from './areas';

/**
 * A spec's metadata block (docs/specs/living-specs.md §18, R-14, R-31): the
 * mechanical fields of its repo copy (`verified_by`, `surfaces`,
 * `last_verified`, `assertions`, `owner`), kept outside every revision. An
 * area also keeps there the `domains` it covers, and a spec matched to a repo
 * file on import its `repo_provenance`.
 *
 * Any spec or area also keeps its `publication` mark there (Slice 14, R-66):
 * private, public, or absent to follow the policy. Only a person marks one
 * public or lifts a private mark.
 *
 * Anyone with write access to the workspace's specs changes it, an agent or CI
 * included, with a reason. One statement writes the block (only while it is
 * still what the writer read) and one change row per field with who, why and
 * the previous value. It never writes a spec revision, so the version, the
 * approved revision and its content hash do not move (AC-93). An approved spec
 * in a workspace that opted in gets its generated PR updated (R-15).
 */

export const METADATA_KEYS = ['owner', 'last_verified', 'surfaces', 'verified_by', 'assertions', 'domains', 'repo_provenance', 'publication'] as const;
type Key = (typeof METADATA_KEYS)[number];
/** The fields a repo spec file states, and so the ones an import writes and clears. */
export const FILE_METADATA_KEYS = ['owner', 'last_verified', 'surfaces', 'verified_by', 'assertions'] as const;

/** A `domain:` value: lowercase words joined by hyphens, like the repo's DOMAINS list. */
export const DOMAIN_VALUE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SHA = /^[0-9a-f]{40}$/;

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
    case 'domains': {
      const list = Array.isArray(raw) && raw.length <= 20 && raw.every((d) => typeof d === 'string') ? [...new Set((raw as string[]).map((d) => d.trim().toLowerCase()))] : null;
      if (!list || !list.every((d) => DOMAIN_VALUE.test(d))) return { error: 'domains is a list of up to 20 domain values, lowercase words joined by hyphens (e.g. ["tasks", "missions"])' };
      return { value: list };
    }
    case 'publication':
      // R-66: "policy" (follow the workspace's publication policy) is the default, stored as no mark.
      if (raw === 'policy') return { value: null };
      return raw === 'private' || raw === 'public' ? { value: raw } : { error: 'publication is private, public or policy (follow the publication policy)' };
    case 'repo_provenance': {
      const p = raw as Record<string, unknown>;
      const ok = !!p && typeof p === 'object' && !Array.isArray(p) && typeof p.path === 'string' && /^docs\/specs\/[^/]+\.md$/.test(p.path)
        && typeof p.commitSha === 'string' && SHA.test(p.commitSha)
        && (p.blobSha == null || (typeof p.blobSha === 'string' && SHA.test(p.blobSha)))
        && (p.prNumber == null || (typeof p.prNumber === 'number' && Number.isInteger(p.prNumber) && p.prNumber > 0));
      return ok
        ? { value: { path: p.path as string, commitSha: p.commitSha as string, blobSha: (p.blobSha as string | null | undefined) ?? null, prNumber: (p.prNumber as number | null | undefined) ?? null } }
        : { error: 'repo_provenance is { path: docs/specs/<file>.md, commitSha, blobSha?, prNumber? } with full SHAs' };
    }
  }
}

/** Equal as JSON values, whatever the key order (jsonb stores keys in its own order). */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

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
  // R-66: an agent may only make a spec more private. Opening one to the repo
  // past the policy (public), or lifting a private mark, is a person's mark.
  if ('publication' in parsed && caller.kind !== 'user' && parsed.publication !== 'private') {
    return fail(403, 'Only a person marks a spec public or lifts its private mark; an agent may mark it private.');
  }
  if (parsed.domains) {
    // Only an area covers domains, and each value names one area: placement and the repo copy must not have to choose.
    if (spec.scope !== 'domain') return fail(400, 'domains is set on an area (a spec with scope domain), not on a feature or product spec');
    const others = await db.select({ id: specs.id, title: specs.title, metadata: specs.metadata }).from(specs)
      .where(and(eq(specs.workspaceId, spec.workspaceId), eq(specs.scope, 'domain'), ne(specs.id, specId), notInArray(specs.status, [...AREA_GONE_STATUSES])));
    const taken = (parsed.domains as string[]).map((d) => [d, others.find((o) => (o.metadata?.domains ?? []).includes(d))] as const).filter(([, o]) => o);
    if (taken.length) return fail(409, `already covered by another area: ${taken.map(([d, o]) => `${d} (${o!.title}, ${o!.id})`).join(', ')}. Remove it there first.`);
  }

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
