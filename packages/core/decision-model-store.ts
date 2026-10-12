/**
 * Writes one decision's model override into `teams.decision_model`
 * (`byKind`, see `decision-model.ts`). The optimizer calls it once a model has
 * been measured as better on a decision; an owner can call it too.
 *
 * Atomic without a transaction: read the stored value, compute the next one,
 * and write it only where the column still holds what was read
 * (`UPDATE … WHERE decision_model = <read>`). A concurrent write makes that
 * miss, and the write is retried on top of it, so neither is lost.
 *
 * Setting an override does not let the model act: that is still its stored
 * measurement for the (decision, model) pair. Unmeasured, it records only.
 */
import {
  decisionModelKindLabel,
  isDecisionModelKind,
  normalizeDecisionModelOverride,
  readDecisionModelOverrides,
  withDecisionModelForKind,
  type DecisionModelConfig,
  type DecisionModelKind,
  type DecisionModelRoute,
  type DecisionModelSetting,
} from './decision-model';

export interface DecisionModelAuditEvent {
  actorAccountId: string | null;
  action: 'team.decision_model.kind.update';
  targetType: 'team';
  targetId: string;
  teamId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface DecisionModelStoreDeps {
  /** The team's stored `decision_model`, or not found. */
  read?: (teamId: string) => Promise<{ found: boolean; value: unknown }>;
  /** Write `next` only where the column still equals `expected`; false when it did not. */
  compareAndSet?: (teamId: string, expected: unknown, next: DecisionModelSetting | null) => Promise<boolean>;
  audit?: (event: DecisionModelAuditEvent) => Promise<void>;
}

export type SetDecisionModelResult =
  | { ok: true; kind: DecisionModelKind; before: DecisionModelRoute | null; after: DecisionModelRoute | null; stored: DecisionModelSetting | null }
  | { ok: false; error: string };

const MAX_ATTEMPTS = 5;

/**
 * Set (or with null, clear) the model one decision uses for a team. `by` is
 * the acting account (null for the optimizer); `reason` is kept in the audit row.
 */
export async function setDecisionModelForKind(
  teamId: string,
  kind: DecisionModelKind,
  config: unknown,
  meta: { by: string | null; reason: string | null },
  deps: DecisionModelStoreDeps = {},
): Promise<SetDecisionModelResult> {
  if (!isDecisionModelKind(kind)) return { ok: false, error: `unknown decision '${String(kind)}'` };
  const checked = normalizeDecisionModelOverride(kind, config);
  if (!checked.ok) return checked;
  const route = checked.value;

  const read = deps.read ?? dbRead;
  const compareAndSet = deps.compareAndSet ?? dbCompareAndSet;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await read(teamId);
    if (!current.found) return { ok: false, error: 'team not found' };
    const before = readDecisionModelOverrides(current.value)[kind] ?? null;
    const next = withDecisionModelForKind(current.value, kind, route);
    if (!(await compareAndSet(teamId, current.value, next))) continue;
    await (deps.audit ?? dbAudit)({
      actorAccountId: meta.by,
      action: 'team.decision_model.kind.update',
      targetType: 'team',
      targetId: teamId,
      teamId,
      before: { kind, model: before },
      after: { kind, model: route, reason: meta.reason },
    });
    return { ok: true, kind, before, after: route, stored: next };
  }
  return { ok: false, error: `decision model for ${decisionModelKindLabel(kind)} changed concurrently; not written` };
}

// ── Default deps (lazy: the DB client imports `server-only`) ─────────────────

async function dbRead(teamId: string): Promise<{ found: boolean; value: unknown }> {
  const { db } = await import('./db');
  const { teams } = await import('./db/schema');
  const { eq } = await import('drizzle-orm');
  const row = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { decisionModel: true } });
  return row ? { found: true, value: row.decisionModel ?? null } : { found: false, value: null };
}

async function dbCompareAndSet(teamId: string, expected: unknown, next: DecisionModelSetting | null): Promise<boolean> {
  const { db } = await import('./db');
  const { teams } = await import('./db/schema');
  const { and, eq, isNull, sql } = await import('drizzle-orm');
  const same = expected === null || expected === undefined
    ? isNull(teams.decisionModel)
    : sql`${teams.decisionModel} = ${JSON.stringify(expected)}::jsonb`;
  const rows = await db.update(teams)
    // The column's type names the default-bearing shape; overrides alone are valid too (decision-model.ts).
    .set({ decisionModel: next as DecisionModelConfig | null, updatedAt: new Date() })
    .where(and(eq(teams.id, teamId), same))
    .returning({ id: teams.id });
  return rows.length > 0;
}

async function dbAudit(event: DecisionModelAuditEvent): Promise<void> {
  const { db } = await import('./db');
  const { platformAdminAuditEvents } = await import('./db/schema');
  await db.insert(platformAdminAuditEvents).values(event);
}
