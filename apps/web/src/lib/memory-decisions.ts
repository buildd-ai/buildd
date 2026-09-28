/**
 * Web wiring for the memory Jev decisions (@buildd/core/memory-decisions).
 *
 * - Key: the team's OpenRouter key through the shared resolver
 *   (`resolveDecisionKey`). No key, nothing runs and nothing is logged.
 * - Log: every verdict is a `memory_decisions` row; every call that reached
 *   the provider is also an `ai_usage` receipt (surface 'decision') when the
 *   acting account is known. Both are written after the response (`after()`),
 *   never on the request path, and a failed insert costs the rows only.
 * - Relevance shadow: installed into retrieveMemory by `installMemoryRelevanceShadow`
 *   (called from ./memory-ledger, which every web read path already loads).
 *   It is scheduled after the response, so it adds no claim latency.
 * - Use labels: `scheduleMemoryUseLabels`, from the worker completion route.
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
import { setMemoryRelevanceShadow, type MemoryRelevanceShadow } from '@buildd/core/memory-retrieval';
import type { DecisionReceipt } from '@builddai/ai-kit/decide';

type Schedule = (task: () => Promise<unknown>) => void;

const inert = () => process.env.NODE_ENV === 'test';

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
export function decisionUsageRow(receipt: DecisionReceipt, scope: { teamId: string; accountId: string }) {
  const cost = receipt.usage.costUsd;
  return {
    teamId: scope.teamId,
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

async function insertDecisionRows(rows: MemoryDecisionRow[], receipts: DecisionReceipt[], scope: MemoryDecisionScope): Promise<void> {
  const { db } = await import('@buildd/core/db');
  const { memoryDecisions, aiUsage } = await import('@buildd/core/db/schema');
  if (rows.length > 0) await db.insert(memoryDecisions).values(rows).catch(() => {});
  if (receipts.length > 0 && scope.accountId) {
    const accountId = scope.accountId;
    await db.insert(aiUsage).values(receipts.map(r => decisionUsageRow(r, { teamId: scope.teamId, accountId }))).catch(() => {});
  }
}

async function resolveKey(scope: MemoryDecisionScope): Promise<string | null> {
  if (inert()) return null;
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

/** A decider for one request's acting account (null: no ai_usage receipt). */
export function memoryDeciderFor(accountId?: string | null): MemoryDecider {
  return createMemoryDecider(webMemoryDecisionDeps({ accountId }));
}

// ── Relevance shadow ─────────────────────────────────────────────────────────

/**
 * The hook retrieveMemory calls. It returns at once; the Jev calls and their
 * log rows run in one `after()` task, so a claim never waits on them.
 */
export function createRelevanceShadow(
  deciderFor: (pending: Promise<unknown>[]) => MemoryDecider = pending => createMemoryDecider(webMemoryDecisionDeps({ pending })),
  schedule: Schedule = after,
): MemoryRelevanceShadow {
  return (input) => {
    scheduleAfter(async () => {
      const pending: Promise<unknown>[] = [];
      await deciderFor(pending).shadowRelevance({
        scope: { teamId: input.teamId, workspaceId: input.workspaceId, taskId: input.taskId },
        task: input.query,
        caller: input.caller,
        hits: input.hits.map(h => ({ memoryId: h.memoryId, content: h.content, gatedBy: h.gatedBy })),
      });
      await Promise.all(pending);
    }, schedule);
  };
}

let installed = false;

/** Install the relevance shadow once per process. Inert under test. */
export function installMemoryRelevanceShadow(): void {
  if (installed || inert()) return;
  installed = true;
  setMemoryRelevanceShadow(createRelevanceShadow());
}

// ── Use labels on completion ─────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dbUseLabelDeps(decider: MemoryDecider): UseLabelDeps {
  return {
    decider,
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
 * MAX_USE_LABELS_PER_TASK calls. Sensitive workspaces are skipped by the caller.
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
