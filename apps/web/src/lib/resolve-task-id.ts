/**
 * Resolve a task id that may be an 8+ character prefix to the full UUID,
 * scoped to what the caller can access.
 *
 * The UI, KB memories and friction reports cite tasks by their 8-char prefix,
 * so a caller following one of those leads into a read endpoint used to get a
 * rejection (or a Postgres uuid cast error) and had to go search for the full
 * id. Read endpoints can resolve it instead.
 *
 * Tenancy: candidates are fetched by prefix and then filtered through the
 * caller's own workspace-access check BEFORE anything is reported. A prefix
 * that only matches another tenant's task is indistinguishable from one that
 * matches nothing (404), and an ambiguity response lists only accessible
 * candidates.
 *
 * Use this for READ paths only. Mutations keep requiring the full UUID: a
 * prefix collision there would act on the wrong task.
 *
 * Server-only: imports the db.
 */
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { sql, type SQL } from 'drizzle-orm';

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 8+ hex chars, optionally continuing into the dashed UUID form (dash positions checked separately). */
const PREFIX_RE = /^[0-9a-f]{8}[0-9a-f-]{0,27}$/i;
/**
 * Rows fetched per prefix before the access filter. An 8-hex prefix spans
 * ~4 billion ids, so more than a handful of matches is not a realistic case;
 * the cap only bounds the pathological one.
 */
const CANDIDATE_SCAN = 10;

export type TaskIdResolution =
  | { ok: true; id: string; resolvedFrom?: string }
  | { ok: false; status: 400 | 404 | 409; error: string; candidates?: Array<{ id: string; title: string }> };

const UUID_TEMPLATE = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';

/** True when `prefix` is a leading slice of the canonical uuid layout (dashes only at 8/13/18/23). */
function isCanonicalUuidPrefix(prefix: string): boolean {
  for (let i = 0; i < prefix.length; i++) {
    if ((UUID_TEMPLATE[i] === '-') !== (prefix[i] === '-')) return false;
  }
  return true;
}

function padToUuid(hex: string, fill: '0' | 'f'): string {
  const h = hex.padEnd(32, fill);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Ids starting with `prefix`, as a uuid range. Postgres orders uuids bytewise,
 * which is hex order, so [prefix+0…, prefix+f…] is exactly the prefix set — and
 * unlike `id::text like 'p%'` it can use the primary-key index, so a prefix that
 * matches nothing does not scan every tenant's tasks.
 */
export function taskIdPrefixPredicate(prefix: string): SQL {
  const hex = prefix.toLowerCase().replace(/-/g, '');
  const low = padToUuid(hex, '0');
  const high = padToUuid(hex, 'f');
  return sql`(${tasks.id} >= ${low}::uuid and ${tasks.id} <= ${high}::uuid)`;
}

export async function resolveTaskIdForCaller(
  raw: string,
  canAccessWorkspace: (workspaceId: string) => Promise<boolean>,
): Promise<TaskIdResolution> {
  if (FULL_UUID_RE.test(raw)) return { ok: true, id: raw };

  if (!PREFIX_RE.test(raw) || !isCanonicalUuidPrefix(raw)) {
    return {
      ok: false,
      status: 400,
      error: 'task id must be a full UUID or a prefix of at least 8 hex characters',
    };
  }

  const prefix = raw.toLowerCase();
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(taskIdPrefixPredicate(prefix))
    .limit(CANDIDATE_SCAN);

  const accessible: Array<{ id: string; title: string }> = [];
  for (const row of rows) {
    if (await canAccessWorkspace(row.workspaceId)) accessible.push({ id: row.id, title: row.title });
  }

  if (accessible.length === 0) {
    return { ok: false, status: 404, error: `No accessible task with ID prefix "${prefix}"` };
  }
  if (accessible.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Task ID prefix "${prefix}" is ambiguous; pass one of the full ids`,
      candidates: accessible,
    };
  }
  return { ok: true, id: accessible[0].id, resolvedFrom: prefix };
}
