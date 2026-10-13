/**
 * The production side of the operator-recovery decisions: the decision
 * ledger as cache, `system_cache` for the dedupe claim, the breaker and the
 * kind switches, today's spend from the ledger, `runBuilddDecision` and
 * `inferenceCall` for the two requests, and the outcome and health passes.
 *
 * `operatorKindHealthInput` is pure (the readout's side of §6.5); the rest
 * touches Postgres through lazy imports.
 */
import type { DecisionLedgerInput } from '@buildd/core/decision-ledger';
import {
  OPERATOR_KIND_DEFS, OPERATOR_OUTCOME_SOURCE, OPERATOR_RECOVERY_KINDS, evaluateOperatorKindHealth,
  type OperatorKindHealthInput, type OperatorRecoveryKind,
} from '@buildd/core/decision-kind-operator-recovery';
import { computeDecisionReadout, type DecisionReadout, type ReadoutDecisionRow, type ReadoutOutcomeRow } from '@buildd/core/decision-readout';
import {
  BREAKER_FAILURES, BREAKER_OPEN_MS, CLAIM_MS, CLAIM_PREFIX, DAILY_CALLS, DAILY_USD, KIND_OFF_PREFIX, MODEL_BREAKER_KEY, MODEL_FAILURES_KEY,
  MAX_OUTPUT_TOKENS, OPERATOR_DECISION_TIMEOUT_MS, type OperatorDecisionDeps,
} from './operator-recovery-decisions';
import { mergeOutcomeLabel, priorityOutcomeLabel, repairOutcomeLabel } from './operator-recovery-decision-apply';
import type { OperatorPassDeps } from './operator-recovery-pass';

const DAY = 86_400_000;
const HEALTH_WINDOW_DAYS = 30;
const LABEL_WINDOW_DAYS = 14;
const HEALTH_CHECK_KEY = 'operator-recovery-health:checked-at';
const HEALTH_CHECK_EVERY_MS = 60 * 60_000;

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ── Decision deps ───────────────────────────────────────────────────────────

export function productionOperatorDecisionDeps(): OperatorDecisionDeps {
  const load = async () => {
    const [{ db }, schema, orm] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
    return { db, ...schema, ...orm };
  };
  const upsert = async (key: string, value: unknown, expiresAt: Date | null) => {
    const { db, systemCache } = await load();
    await db.insert(systemCache).values({ key, value, updatedAt: new Date(), expiresAt })
      .onConflictDoUpdate({ target: systemCache.key, set: { value, updatedAt: new Date(), expiresAt } });
  };
  return {
    now: () => new Date(),
    async cached(kind, fingerprint) {
      const { db, decisionRecords, and, eq, or, ne, like, desc } = await load();
      const [row] = await db.select({
        id: decisionRecords.id, appliedAnswer: decisionRecords.appliedAnswer, confidence: decisionRecords.confidence,
        status: decisionRecords.status, reason: decisionRecords.reason,
      }).from(decisionRecords)
        .where(and(eq(decisionRecords.capability, kind), eq(decisionRecords.fingerprint, fingerprint),
          or(ne(decisionRecords.status, 'fallback'), like(decisionRecords.reason, 'rule:%'))))
        .orderBy(desc(decisionRecords.createdAt)).limit(1);
      return row ? { ...row, status: row.status as 'applied' | 'suggested' | 'fallback' } : null;
    },
    async switches() {
      const { db, systemCache, like } = await load();
      const { readAutomationState } = await import('./failure-incident-recovery-automation');
      const [rows, automation] = await Promise.all([
        db.select({ key: systemCache.key }).from(systemCache).where(like(systemCache.key, `${KIND_OFF_PREFIX}%`)),
        readAutomationState(),
      ]);
      return { off: new Set(rows.map(r => r.key.slice(KIND_OFF_PREFIX.length))), modelPaused: automation.paused.model || automation.readError };
    },
    async usageToday() {
      const { db, decisionRecords, and, inArray, gte, sql } = await load();
      const [row] = await db.select({
        calls: sql<number>`count(*) filter (where coalesce(${decisionRecords.attemptCount}, 0) > 0)::int`,
        costUsd: sql<number>`coalesce(sum(${decisionRecords.costUsd}), 0)::float8`,
      }).from(decisionRecords)
        .where(and(inArray(decisionRecords.capability, [...OPERATOR_RECOVERY_KINDS]), gte(decisionRecords.createdAt, startOfUtcDay(new Date()))));
      return row ? { calls: Number(row.calls), costUsd: Number(row.costUsd) } : null;
    },
    async limits() {
      const { readAutomationState } = await import('./failure-incident-recovery-automation');
      const m = (await readAutomationState()).policy.model;
      return {
        dailyUsd: Math.min(m.dailyUsd ?? DAILY_USD, DAILY_USD),
        dailyCalls: Math.min(m.dailyCalls ?? DAILY_CALLS, DAILY_CALLS),
        timeoutMs: Math.min(m.timeoutMs ?? OPERATOR_DECISION_TIMEOUT_MS, OPERATOR_DECISION_TIMEOUT_MS),
      };
    },
    breaker: {
      async openUntil() {
        const { db, systemCache, eq } = await load();
        const [row] = await db.select({ expiresAt: systemCache.expiresAt }).from(systemCache).where(eq(systemCache.key, MODEL_BREAKER_KEY)).limit(1);
        return row?.expiresAt ?? null;
      },
      async failure(now) {
        const { db, systemCache, eq } = await load();
        const [row] = await db.select({ value: systemCache.value }).from(systemCache).where(eq(systemCache.key, MODEL_FAILURES_KEY)).limit(1);
        const prior = (row?.value as { count?: unknown } | undefined)?.count;
        const count = (typeof prior === 'number' ? prior : 0) + 1;
        if (count >= BREAKER_FAILURES) {
          const until = new Date(now.getTime() + BREAKER_OPEN_MS);
          await upsert(MODEL_BREAKER_KEY, { openedAt: now.toISOString(), failures: count }, until);
          await upsert(MODEL_FAILURES_KEY, { count: 0 }, null);
        } else {
          await upsert(MODEL_FAILURES_KEY, { count }, null);
        }
      },
      async success() {
        await upsert(MODEL_FAILURES_KEY, { count: 0 }, null);
      },
    },
    async claim(fingerprint) {
      const { db, systemCache, sql } = await load();
      const expiresAt = new Date(Date.now() + CLAIM_MS);
      const rows = await db.insert(systemCache)
        .values({ key: `${CLAIM_PREFIX}${fingerprint}`, value: { claimedAt: new Date().toISOString() }, updatedAt: new Date(), expiresAt })
        .onConflictDoUpdate({
          target: systemCache.key,
          set: { value: { claimedAt: new Date().toISOString() }, updatedAt: new Date(), expiresAt },
          setWhere: sql`${systemCache.expiresAt} IS NULL OR ${systemCache.expiresAt} < now()`,
        })
        .returning({ key: systemCache.key });
      return rows.length > 0;
    },
    async decide(kind, features, scope, opts) {
      const { runBuilddDecision } = await import('@buildd/core/decision-policy');
      const def = OPERATOR_KIND_DEFS[kind];
      let ledger: DecisionLedgerInput | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await runBuilddDecision(def as any, {
        features, featureSchemaVersion: def.featureSchemaVersion, subjectRef: { type: 'cause', id: opts.subjectId },
        constraints: { maxLatencyMs: opts.timeoutMs, allowEscalation: false },
      }, scope, {
        // The row is written once, by the caller, with both answers and the fallback cause.
        record: async input => { ledger = input; return null; },
      });
      return { response, ledger };
    },
    async explain(_kind, prompt, ctx) {
      const [{ inferenceCall }, { estimateCostUsd }] = await Promise.all([import('@buildd/core/inference-client'), import('@buildd/core/model-prices')]);
      const r = await inferenceCall({
        capability: 'operator_recovery', tier: 'budget', teamId: ctx.teamId, workspaceId: ctx.workspaceId,
        system: prompt.system, user: prompt.user, maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: ctx.timeoutMs, validate: ctx.validate,
      });
      if (!r.ok) return r;
      const costUsd = estimateCostUsd({ [r.model]: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } });
      return { ...r, costUsd };
    },
    async record(input) {
      const { recordDecision } = await import('@buildd/core/decision-ledger');
      return recordDecision(input);
    },
  };
}

// ── Outcome labels (§6.5) ───────────────────────────────────────────────────

/** Label every answered, not-yet-labelled operator decision whose outcome is now known. Returns labels written. */
export async function labelOperatorOutcomes(now: Date = new Date()): Promise<number> {
  const [{ db }, schema, orm, { labelDecisionOutcome }, { GATE_SLUGS }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('@buildd/core/decision-outcomes'), import('@buildd/core/gate-events'),
  ]);
  const { decisionRecords, decisionOutcomes, gateEvents, platformAdminAuditEvents } = schema;
  const { and, eq, gte, inArray, ne, notExists, sql } = orm;
  const since = new Date(now.getTime() - LABEL_WINDOW_DAYS * DAY);
  const rows = await db.select({
    id: decisionRecords.id, teamId: decisionRecords.teamId, capability: decisionRecords.capability, appliedAnswer: decisionRecords.appliedAnswer,
    subjectId: decisionRecords.subjectId, createdAt: decisionRecords.createdAt,
  }).from(decisionRecords)
    .where(and(
      inArray(decisionRecords.capability, [...OPERATOR_RECOVERY_KINDS]), gte(decisionRecords.createdAt, since), ne(decisionRecords.status, 'fallback'),
      notExists(db.select({ one: sql`1` }).from(decisionOutcomes).where(eq(decisionOutcomes.decisionRecordId, decisionRecords.id))),
    )).limit(500);
  if (rows.length === 0) return 0;

  const causeKeys = [...new Set(rows.flatMap(r => (r.subjectId ?? '').split('+')).filter(Boolean))];
  const [audits, attempts] = await Promise.all([
    causeKeys.length
      ? db.select({ targetId: platformAdminAuditEvents.targetId, action: platformAdminAuditEvents.action, occurredAt: platformAdminAuditEvents.occurredAt })
        .from(platformAdminAuditEvents)
        .where(and(sql`${platformAdminAuditEvents.targetType} = 'cause'`, inArray(platformAdminAuditEvents.targetId, causeKeys), gte(platformAdminAuditEvents.occurredAt, since)))
      : Promise.resolve([]),
    db.select({ outcome: gateEvents.outcome, detail: gateEvents.detail }).from(gateEvents)
      .where(and(eq(gateEvents.gate, GATE_SLUGS.INCIDENT_RECOVERY), gte(gateEvents.occurredAt, since), sql`${gateEvents.detail}->>'actor' like 'model:%'`))
      .limit(2000),
  ]);
  const at = (d: Date) => d.toISOString();
  let written = 0;
  for (const r of rows) {
    const kind = r.capability as OperatorRecoveryKind;
    const keys = (r.subjectId ?? '').split('+');
    let label: string | null = null;
    if (kind === 'buildd.operator_cause_merge') {
      if (r.appliedAnswer !== 'merge') continue;
      label = mergeOutcomeLabel(at(r.createdAt), audits.filter(a => a.action === 'recovery.regroup' && keys.includes(a.targetId)).map(a => at(a.occurredAt)), at(now));
    } else if (kind === 'buildd.operator_repair_suggestion') {
      const attempt = attempts.find(a => (a.detail as { actor?: unknown } | null)?.actor === `model:${r.id}`);
      if (!attempt) continue;
      const verify = (attempt.detail as { verify?: { passed?: unknown } }).verify;
      label = repairOutcomeLabel({ outcome: attempt.outcome, verifyPassed: typeof verify?.passed === 'boolean' ? verify.passed : null });
    } else {
      label = priorityOutcomeLabel(at(r.createdAt), audits.filter(a => keys.includes(a.targetId)).map(a => at(a.occurredAt)), at(now));
    }
    if (!label) continue;
    const res = await labelDecisionOutcome({ teamId: r.teamId, decisionRecordId: r.id, source: OPERATOR_OUTCOME_SOURCE[kind], label, observedAt: now });
    if (res.ok && res.results.some(x => x.status === 'recorded')) written++;
  }
  return written;
}

// ── Kind health (§6.5 as the switch-off line) ───────────────────────────────

/** Pure. The readout and the switch-off input for one kind, from its window's rows. */
export function operatorKindHealthInput(
  kind: OperatorRecoveryKind,
  rows: { records: ReadoutDecisionRow[]; outcomes: Array<ReadoutOutcomeRow & { observedAt?: string }> },
  extra: Pick<OperatorKindHealthInput, 'crossTeamWorkspaceMerges' | 'outsideValidAccepted' | 'baselinePassRate'> = {},
): { readout: DecisionReadout; health: OperatorKindHealthInput } {
  const adapter = OPERATOR_KIND_DEFS[kind].binding.readout!;
  const readout = computeDecisionReadout({ records: rows.records, outcomes: rows.outcomes, challengers: [] }, { access: 'enabled', eligibleSubjects: null }, {
    minLabelled: adapter.minLabelled ?? 30, objective: adapter.objective,
  });
  const source = adapter.objective!.source!;
  const byId = new Map(rows.records.map(r => [r.id, r]));
  const mine = rows.outcomes.filter(o => o.source === source);
  let scored = 0, correct = 0;
  for (const o of mine) {
    const rec = byId.get(o.decisionRecordId);
    if (!rec?.applied || !rec.appliedAnswer) continue;
    const s = adapter.objective!.score(o, rec.appliedAnswer);
    if (s === null) continue;
    scored++;
    if (s) correct++;
  }
  const days = new Set(mine.map(o => (o.observedAt ?? '').slice(0, 10)).filter(Boolean));
  return { readout, health: { labelled: mine.length, labelledDays: days.size, scored, correct, ...extra } };
}

/**
 * Evaluate each kind against the switch-off line, at most hourly. A kind
 * that crosses it is switched off by a recorded row
 * (`operator-recovery:kind-off:<kind>`, with the reason and the readout's
 * counts); it stops asking and applying until the row is removed.
 */
export async function evaluateOperatorKindsHealth(now: Date = new Date()): Promise<void> {
  const [{ db }, schema, orm] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
  const { decisionRecords, decisionOutcomes, gateEvents, systemCache } = schema;
  const { and, eq, gte, inArray, sql } = orm;
  const claimed = await db.insert(systemCache)
    .values({ key: HEALTH_CHECK_KEY, value: { at: now.toISOString() }, updatedAt: now, expiresAt: new Date(now.getTime() + HEALTH_CHECK_EVERY_MS) })
    .onConflictDoUpdate({
      target: systemCache.key, set: { value: { at: now.toISOString() }, updatedAt: now, expiresAt: new Date(now.getTime() + HEALTH_CHECK_EVERY_MS) },
      setWhere: sql`${systemCache.expiresAt} IS NULL OR ${systemCache.expiresAt} < now()`,
    }).returning({ key: systemCache.key });
  if (claimed.length === 0) return;

  const since = new Date(now.getTime() - HEALTH_WINDOW_DAYS * DAY);
  const { GATE_SLUGS } = await import('@buildd/core/gate-events');
  const [baseline] = await db.select({
    passed: sql<number>`count(*) filter (where (${gateEvents.detail}->'verify'->>'passed') = 'true')::int`,
    judged: sql<number>`count(*) filter (where (${gateEvents.detail}->'verify'->>'passed') in ('true', 'false'))::int`,
  }).from(gateEvents)
    .where(and(eq(gateEvents.gate, GATE_SLUGS.INCIDENT_RECOVERY), gte(gateEvents.occurredAt, since), sql`coalesce(${gateEvents.detail}->>'actor', '') not like 'model:%'`));
  const baselinePassRate = baseline && Number(baseline.judged) > 0 ? Number(baseline.passed) / Number(baseline.judged) : null;

  for (const kind of OPERATOR_RECOVERY_KINDS) {
    const records = await db.select({
      id: decisionRecords.id, status: decisionRecords.status, applied: decisionRecords.applied, appliedAnswer: decisionRecords.appliedAnswer,
      policyVersion: decisionRecords.policyVersion, provider: decisionRecords.provider, model: decisionRecords.model, attemptCount: decisionRecords.attemptCount,
      escalated: decisionRecords.escalated, failureClass: decisionRecords.failureClass, subjectType: decisionRecords.subjectType, subjectId: decisionRecords.subjectId,
      latencyMs: decisionRecords.latencyMs, costUsd: decisionRecords.costUsd, experimentId: decisionRecords.experimentId, experimentArm: decisionRecords.experimentArm,
    }).from(decisionRecords).where(and(eq(decisionRecords.capability, kind), gte(decisionRecords.createdAt, since))).limit(5000);
    const ids = records.map(r => r.id);
    const outcomes = ids.length
      ? await db.select({ decisionRecordId: decisionOutcomes.decisionRecordId, source: decisionOutcomes.source, label: decisionOutcomes.label, value: decisionOutcomes.value, metadata: decisionOutcomes.metadata, observedAt: decisionOutcomes.observedAt })
        .from(decisionOutcomes).where(inArray(decisionOutcomes.decisionRecordId, ids.slice(0, 5000)))
      : [];
    const { readout, health } = operatorKindHealthInput(kind, {
      records: records.map(r => ({ ...r, status: r.status as ReadoutDecisionRow['status'], escalated: !!r.escalated, costUsd: r.costUsd === null ? null : Number(r.costUsd) })),
      outcomes: outcomes.map(o => ({ ...o, observedAt: o.observedAt.toISOString() })),
    }, kind === 'buildd.operator_repair_suggestion' ? { baselinePassRate } : {});
    const verdict = evaluateOperatorKindHealth(kind, health);
    if (verdict.verdict !== 'switch_off') continue;
    const value = { by: 'readout', reason: verdict.reason, at: now.toISOString(), labelled: readout.outcomes.labelled, collection: readout.collection.state };
    await db.insert(systemCache).values({ key: `${KIND_OFF_PREFIX}${kind}`, value, updatedAt: now, expiresAt: null })
      .onConflictDoNothing({ target: systemCache.key });
    console.warn(`[operator-recovery] ${kind} switched off: ${verdict.reason}`);
  }
}

// ── The pass ────────────────────────────────────────────────────────────────

/** Worker errors of the members' failed workers, newest first: the raw text the pack redacts. */
async function loadExcerpts(members: ReadonlyArray<{ id: string; affectedRefs: { workerIds: string[] }; evidenceRefs: Array<{ kind: string; id: string; note?: string }> }>) {
  const [{ db }, { workers }, { desc, inArray, isNotNull, and }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
  const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const workerIds = [...new Set(members.flatMap(m => m.affectedRefs.workerIds))].filter(uuid).slice(0, 20);
  const notes = members.flatMap(m => m.evidenceRefs.filter(e => e.note).map(e => ({ ref: `${e.kind}:${e.id}`, text: e.note! })));
  const rows = workerIds.length
    ? await db.select({ id: workers.id, error: workers.error }).from(workers).where(and(inArray(workers.id, workerIds), isNotNull(workers.error))).orderBy(desc(workers.createdAt)).limit(4)
    : [];
  return [...rows.map(r => ({ ref: `worker:${r.id}`, text: r.error ?? '' })), ...notes].filter(x => x.text.trim()).slice(0, 4);
}

export async function productionOperatorPassDeps(): Promise<OperatorPassDeps> {
  const [store, { loadRecoveryFacts }, repairs] = await Promise.all([
    import('./failure-incident-store'), import('./admin/data'), import('./failure-incident-repairs'),
  ]);
  const port = await store.createDbIncidentPort();
  return {
    now: () => new Date(),
    loadFacts: () => loadRecoveryFacts({ workspaceIds: [], platformWide: true, window: '7d' }),
    decision: productionOperatorDecisionDeps(),
    port,
    async actionDeps() {
      const { productionOperatorActionDeps } = await import('@/app/api/admin/operator/recovery-action-deps');
      return (await productionOperatorActionDeps()).service;
    },
    repairFacts: (lead, peers) => repairs.loadRepairFacts(lead, peers).catch(() => null),
    excerpts: members => loadExcerpts(members),
    labelOutcomes: () => labelOperatorOutcomes(),
    evaluateHealth: () => evaluateOperatorKindsHealth(),
  };
}
