/**
 * Failure Pattern Sentinel — durable incident persistence.
 *
 * One `failure_incidents` row per (signature, detectorVersion). The rule engine
 * (`failure-pattern-sentinel.ts`) produces candidates; this module folds each
 * into its row so the 2nd and the 200th occurrence of a pattern update one
 * incident instead of opening two.
 *
 * Load-bearing properties:
 *
 * 1. **Idempotent.** An occurrence is counted once, by identity: a candidate's
 *    occurrence refs are diffed against the incident's retained evidence. Once
 *    the bounded evidence is full, anything at or below its oldest retained
 *    instant is treated as already counted (the watermark), so a re-run sweep
 *    over the same facts is a no-op and writes nothing.
 * 2. **Concurrency-safe without transactions** (neon-http has none): insert is
 *    ON CONFLICT DO NOTHING on the unique key, update is a compare-and-swap on
 *    `version`. A loser re-reads and re-merges, bounded by `maxAttempts`.
 * 3. **Never blocks a request path.** `recordIncidentCandidates` swallows every
 *    error. An incident ledger that can fail the completion it is watching is
 *    worse than none — the same rule as `recordGateEvent`.
 * 4. **Severity is a floor.** An update raises severity, never lowers it. Only a
 *    reopen after `resolved` starts again from the candidate's own minimum.
 *
 * The port seam exists so the merge/race logic is tested without a database;
 * `createDbIncidentPort` is the drizzle implementation.
 */
import type {
  FailureIncident,
  FailureIncidentAffectedRefs,
  FailureIncidentSeverity,
} from '@buildd/shared';
import {
  boundEvidenceRefs,
  evidenceKey,
  maxSeverity,
  severityRank,
  MAX_AFFECTED_REFS,
  MAX_EVIDENCE_REFS,
  type IncidentCandidate,
} from './failure-pattern-sentinel';

export type StoredIncident = FailureIncident & { version: number };
export type NewStoredIncident = Omit<StoredIncident, 'id' | 'version'>;

export interface IncidentStorePort {
  find(signature: string, detectorVersion: string): Promise<StoredIncident | null>;
  findById(id: string): Promise<StoredIncident | null>;
  /** ON CONFLICT (signature, detectorVersion) DO NOTHING. Null when the key already exists. */
  insert(row: NewStoredIncident): Promise<StoredIncident | null>;
  /** Write `next` only if the row is still at `expectedVersion`; bumps version. Null when it moved. */
  compareAndSwap(id: string, expectedVersion: number, next: NewStoredIncident): Promise<StoredIncident | null>;
}

export type UpsertOutcome = 'opened' | 'updated' | 'reopened' | 'unchanged';

export interface UpsertIncidentResult {
  incident: StoredIncident;
  outcome: UpsertOutcome;
  /** Severity before this upsert; null when it opened the incident. */
  previousSeverity: FailureIncidentSeverity | null;
  /** Severity strictly rose (an open counts as no escalation). */
  escalated: boolean;
  newOccurrences: number;
  /** Read-merge-write rounds it took (>1 means it lost a race and retried). */
  attempts: number;
}

export const DEFAULT_MAX_UPSERT_ATTEMPTS = 5;

/**
 * Alert bookkeeping kept in `impact` beside the rule's counters, so the paging
 * layer's re-alert state is as durable as `lastAlertSeverity` without a schema
 * change. A detection overwrites the rule's counters but carries these over.
 *  - `alertedScope`: the impact scope (see `impactScope` in
 *    failure-incident-actions.ts) at the last page.
 *  - `alertedRecurrence`: `recurrenceCount` at the last page, so a reopen pages
 *    once and a retry of that page does not.
 */
export const ALERT_IMPACT_KEYS = ['alertedScope', 'alertedRecurrence'] as const;

function carryAlertKeys(prior: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ALERT_IMPACT_KEYS) if (typeof prior?.[k] === 'number') out[k] = prior[k];
  return out;
}

/** The rule's own impact counters, without the alert bookkeeping. */
export function ruleImpact(impact: Record<string, number> | null | undefined): Record<string, number> {
  const out: Record<string, number> = { ...(impact ?? {}) };
  for (const k of ALERT_IMPACT_KEYS) delete out[k];
  return out;
}

function mergeAffected(
  fresh: FailureIncidentAffectedRefs,
  prior: FailureIncidentAffectedRefs,
): FailureIncidentAffectedRefs {
  const merge = <T>(a: T[], b: T[]): T[] => [...new Set([...a, ...b])].slice(0, MAX_AFFECTED_REFS);
  return {
    taskIds: merge(fresh.taskIds, prior.taskIds ?? []),
    workerIds: merge(fresh.workerIds, prior.workerIds ?? []),
    prNumbers: merge(fresh.prNumbers, prior.prNumbers ?? []),
  };
}

function boundAffected(a: FailureIncidentAffectedRefs): FailureIncidentAffectedRefs {
  return mergeAffected(a, { taskIds: [], workerIds: [], prNumbers: [] });
}

export interface MergeResult {
  next: NewStoredIncident;
  outcome: UpsertOutcome;
  newOccurrences: number;
  previousSeverity: FailureIncidentSeverity | null;
  escalated: boolean;
}

/** Pure fold of one candidate into its incident (or a fresh one). */
export function mergeIncident(existing: StoredIncident | null, candidate: IncidentCandidate): MergeResult {
  if (!existing) {
    return {
      outcome: 'opened',
      newOccurrences: candidate.occurrences.length,
      previousSeverity: null,
      escalated: false,
      next: {
        workspaceId: candidate.workspaceId,
        signature: candidate.signature,
        detectorVersion: candidate.detectorVersion,
        rule: candidate.rule,
        reasonCode: candidate.reasonCode,
        title: candidate.title,
        severity: candidate.severity,
        status: 'open',
        firstSeenAt: candidate.firstObservedAt,
        lastSeenAt: candidate.lastObservedAt,
        occurrenceCount: Math.max(1, candidate.occurrences.length),
        recurrenceCount: 0,
        affectedRefs: boundAffected(candidate.affected),
        evidenceRefs: boundEvidenceRefs(candidate.evidence, MAX_EVIDENCE_REFS),
        impact: ruleImpact(candidate.impact),
        lastAlertedAt: null,
        lastAlertSeverity: null,
        linkedFixTaskId: null,
        acknowledgedAt: null,
        resolvedAt: null,
      },
    };
  }

  const retained = new Set(existing.evidenceRefs.map(evidenceKey));
  const floor = existing.evidenceRefs.length >= MAX_EVIDENCE_REFS
    ? existing.evidenceRefs.reduce((min, r) => (r.at < min ? r.at : min), existing.evidenceRefs[0].at)
    : null;
  const fresh = candidate.occurrences.filter(o => !retained.has(evidenceKey(o)) && (floor === null || o.at > floor));

  const { id: _id, version: _version, ...base } = existing;
  const unchanged: MergeResult = {
    outcome: 'unchanged',
    newOccurrences: 0,
    previousSeverity: existing.severity,
    escalated: false,
    next: base,
  };

  const reopening = existing.status === 'resolved';
  if (reopening && fresh.length === 0) return unchanged;

  const severity = reopening ? candidate.severity : maxSeverity(existing.severity, candidate.severity);
  if (!reopening && fresh.length === 0 && severity === existing.severity) return unchanged;

  const freshAts = fresh.map(o => o.at);
  const lastSeenAt = freshAts.reduce((max, at) => (at > max ? at : max), existing.lastSeenAt);
  const firstSeenAt = freshAts.reduce((min, at) => (at < min ? at : min), existing.firstSeenAt);

  return {
    outcome: reopening ? 'reopened' : 'updated',
    newOccurrences: fresh.length,
    previousSeverity: existing.severity,
    escalated: severityRank(severity) > severityRank(existing.severity),
    next: {
      ...base,
      rule: candidate.rule,
      reasonCode: candidate.reasonCode,
      title: candidate.title,
      severity,
      status: reopening ? 'open' : existing.status,
      firstSeenAt,
      lastSeenAt,
      occurrenceCount: existing.occurrenceCount + fresh.length,
      recurrenceCount: existing.recurrenceCount + (reopening ? 1 : 0),
      affectedRefs: mergeAffected(candidate.affected, existing.affectedRefs),
      evidenceRefs: boundEvidenceRefs([...candidate.evidence, ...existing.evidenceRefs], MAX_EVIDENCE_REFS),
      impact: { ...ruleImpact(candidate.impact), ...carryAlertKeys(existing.impact) },
      acknowledgedAt: reopening ? null : existing.acknowledgedAt,
      resolvedAt: reopening ? null : existing.resolvedAt,
    },
  };
}

/**
 * Fold one candidate into its incident row. Throws on store errors or when it
 * loses `maxAttempts` races in a row — callers on a request path must use
 * `recordIncidentCandidates`, which never throws.
 */
export async function upsertIncident(
  port: IncidentStorePort,
  candidate: IncidentCandidate,
  opts: { maxAttempts?: number } = {},
): Promise<UpsertIncidentResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_UPSERT_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const existing = await port.find(candidate.signature, candidate.detectorVersion);
    const merged = mergeIncident(existing, candidate);
    const result = (incident: StoredIncident): UpsertIncidentResult => ({
      incident,
      outcome: merged.outcome,
      previousSeverity: merged.previousSeverity,
      escalated: merged.escalated,
      newOccurrences: merged.newOccurrences,
      attempts: attempt,
    });

    if (!existing) {
      const inserted = await port.insert(merged.next);
      if (inserted) return result(inserted);
      continue; // another writer opened it first — merge into theirs
    }
    if (merged.outcome === 'unchanged') return result(existing);
    const swapped = await port.compareAndSwap(existing.id, existing.version, merged.next);
    if (swapped) return result(swapped);
  }
  throw new Error(`failure incident upsert lost to contention ${maxAttempts} times: ${candidate.signature}`);
}

/**
 * Persist every candidate; NEVER throws. A failing candidate is reported to
 * `onError` (default: console.error) and skipped; the rest still land.
 * Returns the results that landed.
 */
export async function recordIncidentCandidates(
  candidates: ReadonlyArray<IncidentCandidate>,
  opts: { port?: IncidentStorePort; onError?: (err: unknown, candidate: IncidentCandidate | null) => void; maxAttempts?: number } = {},
): Promise<UpsertIncidentResult[]> {
  const onError = opts.onError ?? ((err, c) => {
    console.error(`[failure-incidents] failed to record ${c?.signature ?? '(store unavailable)'}:`, err);
  });
  if (candidates.length === 0) return [];
  let port: IncidentStorePort;
  try {
    port = opts.port ?? (await createDbIncidentPort());
  } catch (err) {
    onError(err, null);
    return [];
  }
  const out: UpsertIncidentResult[] = [];
  for (const c of candidates) {
    try {
      out.push(await upsertIncident(port, c, { maxAttempts: opts.maxAttempts }));
    } catch (err) {
      onError(err, c);
    }
  }
  return out;
}

export type IncidentStateAction =
  | { type: 'acknowledge' }
  | { type: 'resolve' }
  /**
   * A page was claimed at `severity`. Also raises the stored severity to it
   * (a policy layer may raise, never lower) and records the alert scope and
   * recurrence the page covered, when given.
   */
  | { type: 'alerted'; severity: FailureIncidentSeverity; scope?: number; recurrence?: number }
  /** First writer wins: an incident already linked keeps its task. */
  | { type: 'link_fix_task'; taskId: string };

/** Pure: the row after `action`. `updateIncidentState` CASes this; the paging layer uses it inside its own claim loop. */
export function applyIncidentAction(row: StoredIncident, action: IncidentStateAction, now: string): NewStoredIncident {
  const { id: _id, version: _version, ...base } = row;
  switch (action.type) {
    case 'acknowledge':
      return { ...base, status: 'acknowledged', acknowledgedAt: now };
    case 'resolve':
      return { ...base, status: 'resolved', resolvedAt: now };
    case 'alerted':
      return {
        ...base,
        severity: maxSeverity(base.severity, action.severity),
        lastAlertedAt: now,
        lastAlertSeverity: action.severity,
        impact: {
          ...base.impact,
          ...(action.scope !== undefined ? { alertedScope: action.scope } : {}),
          ...(action.recurrence !== undefined ? { alertedRecurrence: action.recurrence } : {}),
        },
      };
    case 'link_fix_task':
      return { ...base, linkedFixTaskId: base.linkedFixTaskId ?? action.taskId };
  }
}

/**
 * Lifecycle and alert bookkeeping for the paging / fix-task layers. Same CAS
 * loop as the upsert. Returns null when the incident does not exist.
 */
export async function updateIncidentState(
  port: IncidentStorePort,
  incidentId: string,
  action: IncidentStateAction,
  opts: { now?: string; maxAttempts?: number } = {},
): Promise<StoredIncident | null> {
  const now = opts.now ?? new Date().toISOString();
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_UPSERT_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const row = await port.findById(incidentId);
    if (!row) return null;
    const swapped = await port.compareAndSwap(row.id, row.version, applyIncidentAction(row, action, now));
    if (swapped) return swapped;
  }
  throw new Error(`failure incident ${action.type} lost to contention ${maxAttempts} times: ${incidentId}`);
}

// ── drizzle port ────────────────────────────────────────────────────────────

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const date = (s: string | null): Date | null => (s ? new Date(s) : null);

/**
 * The database-backed port. Imported lazily so the pure merge logic above (and
 * its tests) never pull in the DB client.
 */
export async function createDbIncidentPort(): Promise<IncidentStorePort> {
  const { db } = await import('@buildd/core/db');
  const { failureIncidents } = await import('@buildd/core/db/schema');
  const { and, eq, sql } = await import('drizzle-orm');
  type Row = typeof failureIncidents.$inferSelect;
  type Insert = typeof failureIncidents.$inferInsert;

  const fromRow = (r: Row): StoredIncident => ({
    id: r.id,
    workspaceId: r.workspaceId,
    signature: r.signature,
    detectorVersion: r.detectorVersion,
    rule: r.rule,
    reasonCode: r.reasonCode,
    title: r.title,
    severity: r.severity,
    status: r.status,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    occurrenceCount: r.occurrenceCount,
    recurrenceCount: r.recurrenceCount,
    affectedRefs: r.affectedRefs ?? { taskIds: [], workerIds: [], prNumbers: [] },
    evidenceRefs: r.evidenceRefs ?? [],
    impact: r.impact ?? {},
    lastAlertedAt: iso(r.lastAlertedAt),
    lastAlertSeverity: r.lastAlertSeverity,
    linkedFixTaskId: r.linkedFixTaskId,
    acknowledgedAt: iso(r.acknowledgedAt),
    resolvedAt: iso(r.resolvedAt),
    version: r.version,
  });

  const toValues = (n: NewStoredIncident): Omit<Insert, 'id' | 'version' | 'createdAt' | 'updatedAt'> => ({
    workspaceId: n.workspaceId,
    signature: n.signature,
    detectorVersion: n.detectorVersion,
    rule: n.rule,
    reasonCode: n.reasonCode,
    title: n.title,
    severity: n.severity,
    status: n.status,
    firstSeenAt: new Date(n.firstSeenAt),
    lastSeenAt: new Date(n.lastSeenAt),
    occurrenceCount: n.occurrenceCount,
    recurrenceCount: n.recurrenceCount,
    affectedRefs: n.affectedRefs,
    evidenceRefs: n.evidenceRefs,
    impact: n.impact,
    lastAlertedAt: date(n.lastAlertedAt),
    lastAlertSeverity: n.lastAlertSeverity,
    linkedFixTaskId: n.linkedFixTaskId,
    acknowledgedAt: date(n.acknowledgedAt),
    resolvedAt: date(n.resolvedAt),
  });

  return {
    async find(signature, detectorVersion) {
      const [r] = await db
        .select()
        .from(failureIncidents)
        .where(and(eq(failureIncidents.signature, signature), eq(failureIncidents.detectorVersion, detectorVersion)))
        .limit(1);
      return r ? fromRow(r) : null;
    },
    async findById(id) {
      const [r] = await db.select().from(failureIncidents).where(eq(failureIncidents.id, id)).limit(1);
      return r ? fromRow(r) : null;
    },
    async insert(row) {
      const [r] = await db
        .insert(failureIncidents)
        .values(toValues(row))
        .onConflictDoNothing({ target: [failureIncidents.signature, failureIncidents.detectorVersion] })
        .returning();
      return r ? fromRow(r) : null;
    },
    async compareAndSwap(id, expectedVersion, next) {
      const [r] = await db
        .update(failureIncidents)
        .set({ ...toValues(next), version: sql`${failureIncidents.version} + 1`, updatedAt: new Date() })
        .where(and(eq(failureIncidents.id, id), eq(failureIncidents.version, expectedVersion)))
        .returning();
      return r ? fromRow(r) : null;
    },
  };
}
