/**
 * Web wiring for the memory Jev decisions (@buildd/core/memory-decisions).
 *
 * - Key: the team's OpenRouter key through the shared resolver
 *   (`resolveDecisionKey`). No key, nothing runs and nothing is logged.
 * - Kill switch: `MEMORY_DECISIONS_DISABLED=1` resolves no key for every
 *   memory decision, so each one takes today's rule.
 * - Log: every verdict is a `memory_decisions` row; every call that reached
 *   the provider is also an `ai_usage` receipt (surface 'decision'), on the
 *   acting account when there is one and on the team alone otherwise. Both
 *   are written after the response (`after()`), never on the request path.
 * - Relevance: installed into retrieveMemory by `installMemoryRelevanceShadow`
 *   (called from ./memory-ledger, which every web read path loads), as two
 *   hooks. The live judge serves claim_context only, on the request path,
 *   inside RELEVANCE_LIVE_BUDGET_MS; `MEMORY_RELEVANCE_LIVE=0` turns it off and
 *   claim_context goes back to the shadow. The shadow serves every other push:
 *   sampled (`MEMORY_RELEVANCE_SHADOW_SAMPLE`, default 0.25) and run after the
 *   response, so it adds no latency. Both re-check that the workspace is
 *   standard and the task attribution holds.
 * - Use labels: `scheduleMemoryUseLabels`, from the worker completion route,
 *   gated by `shouldLabelMemoryUses`.
 *
 * Everything default is inert under `bun test` (NODE_ENV=test): a checkout's
 * env can point at a live database, so no test is one default away from
 * writing rows or spending a key. Tests inject their own deps.
 */
import { after } from 'next/server';
import {
  createMemoryDecider,
  labelTaskMemoryUses,
  type MemoryDecider,
  type MemoryDecisionDeps,
  type MemoryDecisionRow,
  type MemoryDecisionScope,
  type UseLabelDeps,
} from '@buildd/core/memory-decisions';
import {
  setMemoryRelevanceJudge,
  setMemoryRelevanceShadow,
  type MemoryRelevanceJudge,
  type MemoryRelevanceShadow,
  type MemoryRelevanceShadowInput,
} from '@buildd/core/memory-retrieval';
import type { DecisionReceipt } from '@builddai/ai-kit/decide';
import { isStandardWorkspace } from './workspace-data-class';

type Schedule = (task: () => Promise<unknown>) => void;

const inert = () => process.env.NODE_ENV === 'test';

/** Kill switch for every memory decision. */
export function memoryDecisionsDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.MEMORY_DECISIONS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Rollback for the live relevance demotion: `MEMORY_RELEVANCE_LIVE=0` (or
 * false/off/no) leaves claim_context on the rule order with the sampled
 * shadow, exactly as before. Read per call.
 */
export function memoryRelevanceLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.MEMORY_RELEVANCE_LIVE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

export const DEFAULT_RELEVANCE_SHADOW_SAMPLE = 0.25;

/** Share of pushed retrievals the relevance shadow looks at, in [0, 1]. */
export function relevanceShadowSampleRate(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MEMORY_RELEVANCE_SHADOW_SAMPLE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RELEVANCE_SHADOW_SAMPLE;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_RELEVANCE_SHADOW_SAMPLE;
}

/** `after()` when inside a request, fire-and-forget otherwise. Never throws. */
export function scheduleAfter(task: () => Promise<unknown>, schedule: Schedule = after): void {
  const run = () => task().catch(() => {});
  try {
    schedule(run);
  } catch {
    void run();
  }
}

/** The ai_usage row for one decision receipt. Content-free by construction. */
export function decisionUsageRow(receipt: DecisionReceipt, scope: { teamId: string; accountId: string | null }) {
  const cost = receipt.usage.costUsd;
  return {
    teamId: scope.teamId,
    // NULL: a buildd-internal decision with no acting account, on the team alone.
    accountId: scope.accountId,
    planId: null,
    tier: null,
    surface: 'decision',
    kind: receipt.decisionId,
    provider: 'openrouter',
    model: receipt.model,
    planSource: 'fallback',
    inputTokens: receipt.usage.inputTokens,
    outputTokens: receipt.usage.outputTokens,
    costUsd: (cost ?? 0).toFixed(6),
    costSource: cost === null ? 'estimated' as const : 'reported' as const,
    latencyMs: Math.max(0, Math.round(receipt.latencyMs)),
    outcome: receipt.outcome,
  };
}

/**
 * Write decision receipts as `ai_usage` rows. Never throws; inert under test.
 * Also used for decisions outside the memory decider (chat routing).
 */
export async function insertDecisionReceipts(receipts: DecisionReceipt[], scope: { teamId: string; accountId?: string | null }): Promise<void> {
  if (receipts.length === 0 || inert()) return;
  try {
    const { db } = await import('@buildd/core/db');
    const { aiUsage } = await import('@buildd/core/db/schema');
    await db.insert(aiUsage).values(receipts.map(r => decisionUsageRow(r, { teamId: scope.teamId, accountId: scope.accountId ?? null })));
  } catch { /* a receipt never fails the call it records */ }
}

async function insertDecisionRows(rows: MemoryDecisionRow[], receipts: DecisionReceipt[], scope: MemoryDecisionScope): Promise<void> {
  const { db } = await import('@buildd/core/db');
  const { memoryDecisions } = await import('@buildd/core/db/schema');
  if (rows.length > 0) await db.insert(memoryDecisions).values(rows).catch(() => {});
  await insertDecisionReceipts(receipts, scope);
}

async function resolveKey(scope: MemoryDecisionScope): Promise<string | null> {
  if (inert() || memoryDecisionsDisabled()) return null;
  try {
    const { resolveDecisionKey } = await import('@buildd/core/decision-client');
    return await resolveDecisionKey({ teamId: scope.teamId, workspaceId: scope.workspaceId ?? null, accountId: scope.accountId ?? null });
  } catch {
    return null;
  }
}

/**
 * The DB-backed deps. `accountId`, when given, fills scopes that lack one.
 * `pending`: for work already running inside `after()`, collect the inserts
 * so that task can await them, instead of scheduling a nested `after()`.
 */
export function webMemoryDecisionDeps(opts: { accountId?: string | null; schedule?: Schedule; pending?: Promise<unknown>[] } = {}): MemoryDecisionDeps {
  const withAccount = (s: MemoryDecisionScope): MemoryDecisionScope =>
    (s.accountId || !opts.accountId ? s : { ...s, accountId: opts.accountId });
  return {
    resolveKey: s => resolveKey(withAccount(s)),
    record: (rows, receipts, s) => {
      if (inert()) return;
      if (opts.pending) {
        opts.pending.push(insertDecisionRows(rows, receipts, withAccount(s)).catch(() => {}));
        return;
      }
      scheduleAfter(() => insertDecisionRows(rows, receipts, withAccount(s)), opts.schedule);
    },
  };
}

/** A decider for one request's acting account (null: receipted on the team). */
export function memoryDeciderFor(accountId?: string | null): MemoryDecider {
  return createMemoryDecider(webMemoryDecisionDeps({ accountId }));
}

// ── Relevance shadow ─────────────────────────────────────────────────────────

export interface RelevanceShadowDeps {
  deciderFor: (pending: Promise<unknown>[]) => MemoryDecider;
  /** The workspace row, or null when it cannot be read (then: skip). */
  loadWorkspace: (workspaceId: string) => Promise<{ dataClass?: string | null; gitConfig?: { dataClass?: string } | null } | null>;
  /** The ledger's attribution check (memoryAttributionCheckSql): is this task in this workspace? */
  taskInWorkspace: (taskId: string, workspaceId: string) => Promise<boolean>;
  sampleRate: () => number;
  random: () => number;
  disabled: () => boolean;
}

const dbRelevanceShadowDeps: RelevanceShadowDeps = {
  deciderFor: pending => createMemoryDecider(webMemoryDecisionDeps({ pending })),
  async loadWorkspace(workspaceId) {
    const { db } = await import('@buildd/core/db');
    const { workspaces } = await import('@buildd/core/db/schema');
    const { eq } = await import('drizzle-orm');
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { dataClass: true, gitConfig: true } });
    return ws ? { dataClass: ws.dataClass, gitConfig: ws.gitConfig as { dataClass?: string } | null } : null;
  },
  async taskInWorkspace(taskId, workspaceId) {
    const { db } = await import('@buildd/core/db');
    const { memoryAttributionCheckSql } = await import('@buildd/core/memory-uses-attribution');
    const res = await db.execute(memoryAttributionCheckSql({ taskId, workerId: null, workspaceId }));
    return (res.rows[0] as Record<string, unknown> | undefined)?.task_ok === true;
  },
  sampleRate: () => relevanceShadowSampleRate(),
  random: Math.random,
  disabled: () => memoryDecisionsDisabled(),
};

/** Standard workspace and a task that checks out; any doubt (or failure) is a skip. */
async function shadowAllowed(
  input: MemoryRelevanceShadowInput,
  deps: Pick<RelevanceShadowDeps, 'loadWorkspace' | 'taskInWorkspace'>,
): Promise<boolean> {
  if (!input.workspaceId) return false;
  try {
    const ws = await deps.loadWorkspace(input.workspaceId);
    if (!ws || !isStandardWorkspace(ws)) return false;
    return await deps.taskInWorkspace(input.taskId, input.workspaceId);
  } catch {
    return false;
  }
}

/**
 * The hook retrieveMemory calls. It returns at once; the checks, the Jev
 * calls and their log rows run in one `after()` task, so a claim never waits.
 */
export function createRelevanceShadow(
  deps: Partial<RelevanceShadowDeps> = {},
  schedule: Schedule = after,
): MemoryRelevanceShadow {
  const d: RelevanceShadowDeps = { ...dbRelevanceShadowDeps, ...deps };
  return (input) => {
    if (d.disabled() || d.random() >= d.sampleRate()) return;
    scheduleAfter(async () => {
      if (!(await shadowAllowed(input, d))) return;
      const pending: Promise<unknown>[] = [];
      await d.deciderFor(pending).shadowRelevance({
        scope: { teamId: input.teamId, workspaceId: input.workspaceId, taskId: input.taskId },
        task: input.query,
        caller: input.caller,
        hits: input.hits.map(h => ({ memoryId: h.memoryId, content: h.content, gatedBy: h.gatedBy })),
      });
      await Promise.all(pending);
    }, schedule);
  };
}

// ── Relevance live (claim_context) ───────────────────────────────────────────

export interface RelevanceJudgeDeps {
  /** A decider whose log rows are written after the response. */
  liveDecider: () => MemoryDecider;
  loadWorkspace: RelevanceShadowDeps['loadWorkspace'];
  taskInWorkspace: RelevanceShadowDeps['taskInWorkspace'];
  disabled: () => boolean;
  liveEnabled: () => boolean;
}

const dbRelevanceJudgeDeps: RelevanceJudgeDeps = {
  liveDecider: () => createMemoryDecider(webMemoryDecisionDeps()),
  loadWorkspace: dbRelevanceShadowDeps.loadWorkspace,
  taskInWorkspace: dbRelevanceShadowDeps.taskInWorkspace,
  disabled: () => memoryDecisionsDisabled(),
  liveEnabled: () => memoryRelevanceLiveEnabled(),
};

/**
 * The live judge retrieveMemory awaits on the claim path. The workspace and
 * attribution checks spend from the same budget as the Jev calls, and the
 * retrieval races the whole thing against that budget, so a slow DB read or
 * provider costs at most the budget and then the rule order. Null (did not
 * judge) leaves the retrieval to the shadow.
 */
export function createRelevanceJudge(deps: Partial<RelevanceJudgeDeps> = {}): MemoryRelevanceJudge {
  const d: RelevanceJudgeDeps = { ...dbRelevanceJudgeDeps, ...deps };
  return async (input) => {
    if (d.disabled() || !d.liveEnabled()) return null;
    const started = Date.now();
    if (!(await shadowAllowed(input, d))) return null;
    const decider = d.liveDecider();
    if (!decider.judgeRelevance) return null;
    return decider.judgeRelevance({
      scope: { teamId: input.teamId, workspaceId: input.workspaceId, taskId: input.taskId },
      task: input.query,
      caller: input.caller,
      hits: input.hits.map(h => ({ memoryId: h.memoryId, content: h.content, gatedBy: h.gatedBy, mandatory: h.mandatory === true })),
      budgetMs: Math.max(1, input.budgetMs - (Date.now() - started)),
    });
  };
}

let installed = false;

/** Install the relevance hooks (live judge and shadow) once per process. Inert under test. */
export function installMemoryRelevanceShadow(): void {
  if (installed || inert()) return;
  installed = true;
  setMemoryRelevanceShadow(createRelevanceShadow());
  setMemoryRelevanceJudge(createRelevanceJudge());
}

// ── Use labels on completion ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Should a worker PATCH label its task's memory uses? Only on the transition
 * into `completed` (a repeated completed PATCH does not ask again), only for a
 * standard workspace by the shared predicate (a missing workspace is a skip),
 * and never for a server refusal.
 */
export function shouldLabelMemoryUses(input: {
  status: string | undefined;
  previousStatus: string | null | undefined;
  taskId: string | null | undefined;
  workspace: { dataClass?: string | null; gitConfig?: { dataClass?: string } | null } | null | undefined;
  serverRefusal: boolean;
}): boolean {
  if (input.status !== 'completed' || input.previousStatus === 'completed') return false;
  if (!input.taskId || input.serverRefusal) return false;
  if (!input.workspace || !isStandardWorkspace(input.workspace)) return false;
  return !memoryDecisionsDisabled();
}

function dbUseLabelDeps(decider: MemoryDecider): UseLabelDeps {
  return {
    decider,
    async attempted(taskId) {
      const { db } = await import('@buildd/core/db');
      const { memoryDecisions } = await import('@buildd/core/db/schema');
      const { and, eq } = await import('drizzle-orm');
      const rows = await db.select({ id: memoryDecisions.id }).from(memoryDecisions)
        .where(and(eq(memoryDecisions.taskId, taskId), eq(memoryDecisions.decision, 'use')))
        .limit(1);
      return rows.length > 0;
    },
    async loadUses(taskId) {
      const { db } = await import('@buildd/core/db');
      const { memoryUses } = await import('@buildd/core/db/schema');
      const { and, eq, isNull } = await import('drizzle-orm');
      return db
        .select({ teamId: memoryUses.teamId, workspaceId: memoryUses.workspaceId, memoryId: memoryUses.memoryId })
        .from(memoryUses)
        .where(and(eq(memoryUses.taskId, taskId), isNull(memoryUses.gatedBy), isNull(memoryUses.outcome)))
        .orderBy(memoryUses.rank)
        .limit(100);
    },
    async loadMemories(teamId, ids) {
      const valid = ids.filter(id => UUID_RE.test(id));
      if (valid.length === 0) return [];
      const { db } = await import('@buildd/core/db');
      const { memories } = await import('@buildd/core/db/schema');
      const { and, eq, inArray } = await import('drizzle-orm');
      return db
        .select({ id: memories.id, title: memories.title, content: memories.content, type: memories.type })
        .from(memories)
        .where(and(eq(memories.teamId, teamId), inArray(memories.id, valid)));
    },
    async writeOutcomes(taskId, labels) {
      const { db } = await import('@buildd/core/db');
      const { memoryUses } = await import('@buildd/core/db/schema');
      const { and, eq, isNull } = await import('drizzle-orm');
      for (const l of labels) {
        await db.update(memoryUses)
          .set({ outcome: l.outcome })
          .where(and(
            eq(memoryUses.taskId, taskId),
            eq(memoryUses.memoryId, l.memoryId),
            isNull(memoryUses.gatedBy),
            isNull(memoryUses.outcome),
          ));
      }
    },
  };
}

/**
 * After a task completes: label its shown memory uses used / ignored against
 * the final summary. Runs after the response, never on the claim path, at most
 * MAX_USE_LABELS_PER_TASK calls. The caller gates with `shouldLabelMemoryUses`.
 */
export function scheduleMemoryUseLabels(
  input: { taskId: string; accountId?: string | null; summary: string | null | undefined },
  opts: { schedule?: Schedule; deps?: UseLabelDeps } = {},
): void {
  const summary = typeof input.summary === 'string' ? input.summary : '';
  if (!summary.trim() || !UUID_RE.test(input.taskId)) return;
  if (!opts.deps && inert()) return;
  scheduleAfter(async () => {
    const pending: Promise<unknown>[] = [];
    const deps = opts.deps ?? dbUseLabelDeps(createMemoryDecider(webMemoryDecisionDeps({ accountId: input.accountId ?? null, pending })));
    await labelTaskMemoryUses({ taskId: input.taskId, accountId: input.accountId ?? null, summary }, deps);
    await Promise.all(pending);
  }, opts.schedule);
}
