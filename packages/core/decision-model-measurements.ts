/**
 * Which model may act on which decision kind, and at what confidence
 * (`decision_model_measurements`).
 *
 * A kind's thresholds were measured on Jev. Any other model's pick is recorded,
 * never applied, until a measurement for that (kind, model) pair is stored: an
 * eval over the decisions we collected found the lowest threshold at which the
 * model is right often enough, and the platform owner stored it (or applied the
 * eval's proposal). From then on the model acts on that kind above that
 * threshold, with no shadow period.
 *
 * Jev with no row keeps exactly today's behaviour (measured, at the kind's own
 * threshold). A row for Jev overrides its threshold.
 *
 * A row pins the fingerprint of what was measured: the prompt version (or
 * prompt fingerprint) the call site reports. When that changes, the row stops
 * applying and the model records again (`fingerprint_changed`), until it is
 * measured anew. A retired row records only.
 *
 * Reads are cached per instance for a minute and never throw: a failed read is
 * "no rows", so Jev keeps today and every other model records.
 */
import { isClefModel, isJevModel } from './decision-model';

export type MeasurementStatus = 'active' | 'retired';

export interface StoredMeasurement {
  kind: string;
  model: string;
  threshold: number;
  precisionLower: number | null;
  coverage: number | null;
  n: number;
  evalRunId: string | null;
  measuredFingerprint: string;
  status: MeasurementStatus;
  setByAccountId: string | null;
  setAt: Date;
  reason: string | null;
}

export type MeasurementReason = 'jev_default' | 'measured' | 'not_measured' | 'fingerprint_changed' | 'retired';

export interface ModelMeasurement {
  /** May the answer be applied at all? */
  measured: boolean;
  /** The stored threshold; null means "the call site's own threshold" (Jev with no row) or not measured. */
  threshold: number | null;
  reason: MeasurementReason;
}

export interface MeasurementQuery {
  /** The decision kind or decision id the call site uses (`buildd.post_session_triage`, `buildd.orchestration_claim_hold`). */
  kind: string;
  /** The model id that answered, as the provider reported it. */
  answeringModel: string;
  /** What was asked, as the call site versions it (prompt version or prompt fingerprint). */
  fingerprint: string | null;
}

// ── Model matching ───────────────────────────────────────────────────────────

const CLEF_RE = /^(?:@cf\/)?(?:cloudflare\/)?(clef(?:-flash)?)$/;
const MODEL_RE = /^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,127}$/;

/** A stored model id: Clef in its short form, anything else trimmed. */
export function canonicalMeasuredModel(model: string): string {
  const m = CLEF_RE.exec(model.trim());
  return m ? m[1] : model.trim();
}

/** Does a row's model cover the model that answered? Exact, or a dated suffix; Clef and Clef Flash never cover each other. */
function coversModel(rowModel: string, answeringModel: string): boolean {
  const row = canonicalMeasuredModel(rowModel);
  const answered = canonicalMeasuredModel(answeringModel);
  if (row === answered) return true;
  if (isClefModel(row) || isClefModel(answered)) return false;
  return answered.startsWith(`${row}-`);
}

// ── The decision ─────────────────────────────────────────────────────────────

/** Pure: what the stored rows say about one answer. */
export function measurementFor(rows: readonly StoredMeasurement[], q: MeasurementQuery): ModelMeasurement {
  const jev = isJevModel(q.answeringModel);
  const row = rows
    .filter(r => r.kind === q.kind && coversModel(r.model, q.answeringModel))
    // The most specific match wins (a dated row over its undated name).
    .sort((a, b) => b.model.length - a.model.length)[0];

  const fallback = (reason: Exclude<MeasurementReason, 'measured' | 'jev_default'>): ModelMeasurement =>
    jev ? { measured: true, threshold: null, reason: 'jev_default' } : { measured: false, threshold: null, reason };

  if (!row) return fallback('not_measured');
  if (row.status !== 'active') return fallback('retired');
  if (q.fingerprint === null || row.measuredFingerprint !== q.fingerprint) return fallback('fingerprint_changed');
  return { measured: true, threshold: row.threshold, reason: 'measured' };
}

// ── Storage ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: StoredMeasurement[] } | null = null;

/** Drop the per-instance cache (after a write in this instance, and in tests). */
export function clearDecisionModelMeasurementCache(): void { cache = null; }

/** Every stored row, cached for a minute. Throws on a failed read; callers that must not throw use `loadMeasurementsSafe`. */
export async function loadDecisionModelMeasurements(now: () => number = Date.now): Promise<StoredMeasurement[]> {
  const t = now();
  if (cache && t - cache.at < CACHE_TTL_MS) return cache.rows;
  const { db } = await import('./db');
  const { decisionModelMeasurements } = await import('./db/schema');
  const rows = (await db.select().from(decisionModelMeasurements)).map(r => ({
    kind: r.kind,
    model: r.model,
    threshold: r.threshold,
    precisionLower: r.precisionLower,
    coverage: r.coverage,
    n: r.n,
    evalRunId: r.evalRunId,
    measuredFingerprint: r.measuredFingerprint,
    status: r.status as MeasurementStatus,
    setByAccountId: r.setByAccountId,
    setAt: r.setAt,
    reason: r.reason,
  }));
  cache = { at: t, rows };
  return rows;
}

export interface MeasurementDeps {
  load?: () => Promise<readonly StoredMeasurement[]>;
}

/** The stored rows, or none when the read fails (never throws). */
export async function loadMeasurementsSafe(deps: MeasurementDeps = {}): Promise<readonly StoredMeasurement[]> {
  try {
    return await (deps.load ?? (() => loadDecisionModelMeasurements()))();
  } catch (err) {
    console.warn('[decision-model-measurements] read failed, Jev keeps its default and others record:', (err as Error)?.message ?? err);
    return [];
  }
}

/** One answer's measurement, read through the cache. Never throws. */
export async function resolveModelMeasurement(q: MeasurementQuery, deps: MeasurementDeps = {}): Promise<ModelMeasurement> {
  return measurementFor(await loadMeasurementsSafe(deps), q);
}

/** Upsert one (kind, model) row. Throws on a failed write (the route answers 500). */
export async function writeDecisionModelMeasurement(row: Omit<StoredMeasurement, 'setAt'>): Promise<StoredMeasurement> {
  const { db } = await import('./db');
  const { decisionModelMeasurements } = await import('./db/schema');
  const setAt = new Date();
  const values = { ...row, setAt };
  await db.insert(decisionModelMeasurements).values(values).onConflictDoUpdate({
    target: [decisionModelMeasurements.kind, decisionModelMeasurements.model],
    set: {
      threshold: values.threshold,
      precisionLower: values.precisionLower,
      coverage: values.coverage,
      n: values.n,
      evalRunId: values.evalRunId,
      measuredFingerprint: values.measuredFingerprint,
      status: values.status,
      setByAccountId: values.setByAccountId,
      setAt,
      reason: values.reason,
    },
  });
  clearDecisionModelMeasurementCache();
  return values;
}

/** Mark one (kind, model) row retired. Returns the row after, or null when there was none. */
export async function retireDecisionModelMeasurement(input: { kind: string; model: string; setByAccountId: string | null; reason: string | null }): Promise<StoredMeasurement | null> {
  const { db } = await import('./db');
  const { decisionModelMeasurements } = await import('./db/schema');
  const { and, eq } = await import('drizzle-orm');
  const setAt = new Date();
  const [r] = await db.update(decisionModelMeasurements)
    .set({ status: 'retired', setByAccountId: input.setByAccountId, setAt, reason: input.reason })
    .where(and(eq(decisionModelMeasurements.kind, input.kind), eq(decisionModelMeasurements.model, input.model)))
    .returning();
  clearDecisionModelMeasurementCache();
  return r ? { ...r, status: r.status as MeasurementStatus } : null;
}

// ── The admin write, validated ───────────────────────────────────────────────

export type MeasurementWritePlan =
  | { ok: true; action: 'set'; row: Omit<StoredMeasurement, 'setAt' | 'setByAccountId'> }
  | { ok: true; action: 'retire'; kind: string; model: string; reason: string | null }
  | { ok: false; status: 400; error: string };

const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const KIND_RE = /^[a-z][a-z0-9_.:-]{0,127}$/;

/** Validate a POST body. Pure. */
export function planMeasurementWrite(body: unknown): MeasurementWritePlan {
  const bad = (error: string): MeasurementWritePlan => ({ ok: false, status: 400, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be an object');
  const b = body as Record<string, unknown>;
  const kind = typeof b.kind === 'string' ? b.kind.trim() : '';
  const model = typeof b.model === 'string' ? canonicalMeasuredModel(b.model) : '';
  if (!KIND_RE.test(kind)) return bad('kind is required (a decision kind or decision id)');
  if (!MODEL_RE.test(model)) return bad('model is required (the model id that answers)');
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;

  if (b.action === 'retire') return { ok: true, action: 'retire', kind, model, reason };
  if (b.action !== undefined && b.action !== 'set') return bad("action must be 'set' or 'retire'");

  if (!isUnit(b.threshold)) return bad('threshold must be a number in [0, 1]');
  if (b.precisionLower !== undefined && b.precisionLower !== null && !isUnit(b.precisionLower)) return bad('precisionLower must be in [0, 1]');
  if (b.coverage !== undefined && b.coverage !== null && !isUnit(b.coverage)) return bad('coverage must be in [0, 1]');
  if (typeof b.n !== 'number' || !Number.isInteger(b.n) || b.n < 1) return bad('n must be a positive integer (labelled cases measured)');
  const fingerprint = typeof b.measuredFingerprint === 'string' ? b.measuredFingerprint.trim() : '';
  if (!fingerprint || fingerprint.length > 200) return bad('measuredFingerprint is required: what was measured, as the call site versions it');
  const evalRunId = typeof b.evalRunId === 'string' && b.evalRunId.trim() ? b.evalRunId.trim().slice(0, 100) : null;

  return {
    ok: true,
    action: 'set',
    row: {
      kind,
      model,
      threshold: b.threshold,
      precisionLower: (b.precisionLower as number | null | undefined) ?? null,
      coverage: (b.coverage as number | null | undefined) ?? null,
      n: b.n,
      evalRunId,
      measuredFingerprint: fingerprint,
      status: 'active',
      reason,
    },
  };
}
