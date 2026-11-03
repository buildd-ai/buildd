import { db } from '@buildd/core/db';
import { specs, tasks } from '@buildd/core/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { isUuid } from '@/lib/uuid';
import { pinSpecSource } from './pin';
import { repinSpecAtClaim } from './claim-pin';
import type { SpecCaller } from './store';

/**
 * Specify → Build (living-specs.md §20, R-81 to R-84). The common shape is
 * two tasks: one drafts or revises a Living Spec, a second, filed with
 * `dependsOn` on the first, builds it. The second is usually filed before the
 * spec exists, so it cannot name it, and a builder that does not know it may
 * build ahead of approval asks a person to approve, again on every attempt.
 *
 * - R-81: a task-scoped write of a spec revision is recorded on the writing
 *   task (`context.specAuthored`). A dependent that names no spec inherits it
 *   at claim, pinned the ordinary way (./pin.ts): the approved revision, else
 *   the head, provisional.
 * - R-82: every claim of a pinned task carries a brief saying which revision
 *   it builds and, when provisional, to build and not ask for approval.
 * - R-83: the first claim of a provisional pin asks the approvers once,
 *   through the existing approval push and the inbox; never again for the same
 *   revision from that task.
 * Nothing here approves, and nothing moves a pin a person or filer chose.
 */

export const SPEC_AUTHORED_KEY = 'specAuthored' as const;
export const SPEC_APPROVAL_ASKED_KEY = 'specApprovalAsked' as const;

type Ctx = Record<string, unknown> | null | undefined;
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The spec a task wrote, from its context. */
export function authoredSpecFrom(context: Ctx): { specId: string; revision: number } | null {
  const a = asRecord(asRecord(context)?.[SPEC_AUTHORED_KEY]);
  if (!a || typeof a.specId !== 'string' || !isUuid(a.specId) || !Number.isInteger(a.revision)) return null;
  return { specId: a.specId, revision: a.revision as number };
}

/**
 * The spec a task should inherit from its dependencies (R-81): exactly one
 * distinct spec among what they drafted, and only when the task names no spec
 * of its own. Two different specs are ambiguous and nothing is guessed. Pure.
 */
export function inheritableSpec(task: { context: Ctx }, deps: ReadonlyArray<{ id: string; context: Ctx }>): { specId: string; inheritedFrom: string } | null {
  const own = asRecord(asRecord(task.context)?.specSource);
  if (own && own.specId !== undefined) return null;
  let found: { specId: string; inheritedFrom: string } | null = null;
  for (const d of deps) {
    const a = authoredSpecFrom(d.context);
    if (!a) continue;
    if (found && found.specId !== a.specId) return null;
    if (!found) found = { specId: a.specId, inheritedFrom: d.id };
  }
  return found;
}

type Pin = { specId: string; specRevisionId: string; revision: number; provisional: boolean };
function pinOf(src: unknown): Pin | null {
  const s = asRecord(src);
  if (!s || typeof s.specId !== 'string' || !isUuid(s.specId) || typeof s.specRevisionId !== 'string' || !Number.isInteger(s.revision)) return null;
  return { specId: s.specId, specRevisionId: s.specRevisionId, revision: s.revision as number, provisional: s.provisional === true };
}

/** The agent's brief for a pinned task (R-82), or null when it carries no pin. Pure. */
export function specPinBrief(specSource: unknown, title: string | null): string | null {
  const pin = pinOf(specSource);
  if (!pin) return null;
  const name = title ? `"${title}" (${pin.specId})` : pin.specId;
  const read = `Read it with manage_specs { action: "get", specId: "${pin.specId}", revision: ${pin.revision} }, not the head.`;
  if (!pin.provisional) {
    return ['## Living Spec', `This task is pinned to approved revision ${pin.revision} of ${name}. ${read}`].join('\n');
  }
  return [
    '## Living Spec',
    `This task is pinned to revision ${pin.revision} of ${name}, which a person has not approved yet. Build against revision ${pin.revision} now: that is the supported order, not a blocker.`,
    read,
    `- Do not ask a person to approve the spec, and do not wait for approval: buildd has already asked the approvers, and approving re-grades this work on the approved revision.`,
    `- Say "Built ahead of approval, against revision ${pin.revision}." in the PR.`,
    `- Ask a person only for a decision the spec does not settle.`,
  ].join('\n');
}

/** Whether this claim asks the approvers (R-83): a provisional pin this task has not asked about yet. Pure. */
export function shouldAskApproval(context: Ctx): boolean {
  const pin = pinOf(asRecord(context)?.specSource);
  if (!pin?.provisional) return false;
  const asked = asRecord(asRecord(context)?.[SPEC_APPROVAL_ASKED_KEY]);
  return !(asked && asked.specId === pin.specId && asked.revision === pin.revision);
}

/**
 * Record on the writing task the spec revision it wrote (R-81). Only a
 * task-scoped caller (an agent run) has a task; a person or key records
 * nothing. One atomic statement, fail-open: the revision stands either way.
 */
export async function recordSpecAuthoredByTask(caller: SpecCaller, specId: string, revision: number): Promise<void> {
  if (caller.kind !== 'account') return;
  const taskId = (caller.account.taskScope as { taskId?: unknown } | undefined)?.taskId;
  if (typeof taskId !== 'string' || !isUuid(taskId)) return;
  const value = JSON.stringify({ specId, revision, at: new Date().toISOString() });
  try {
    await db.execute(sql`
      UPDATE tasks SET context = jsonb_set(coalesce(context, '{}'::jsonb), ${`{${SPEC_AUTHORED_KEY}}`}::text[], ${value}::jsonb, true)
      WHERE id = ${taskId}::uuid`);
  } catch (err) {
    console.warn(`[specs] recording spec ${specId} on task ${taskId} failed (revision kept):`, (err as Error)?.message ?? err);
  }
}

export type ClaimSpecPin = {
  /** The specSource to write with the claim, or null to keep the context's. */
  specSource: Record<string, unknown> | null;
  reasons: string[];
  /** The prompt brief for the agent (R-82). */
  brief: string | null;
  /** Ask the approvers once (R-83): what to ask about. */
  ask: { specId: string; revision: number; title: string } | null;
};

export const taskHandoffDeps = {
  loadDeps: async (ids: string[]): Promise<Array<{ id: string; context: Ctx }>> => {
    if (ids.length === 0) return [];
    return db.select({ id: tasks.id, context: tasks.context }).from(tasks).where(inArray(tasks.id, ids)) as Promise<Array<{ id: string; context: Ctx }>>;
  },
  specTitle: async (specId: string): Promise<string | null> => {
    const [row] = await db.select({ title: specs.title }).from(specs).where(eq(specs.id, specId)).limit(1);
    return row?.title ?? null;
  },
};

/**
 * The claim's whole spec-pin step: inherit from a dependency (R-81), then the
 * existing claim re-pin (./claim-pin.ts), then the brief and the ask. Reads
 * only; the claim writes the result with its own context update.
 */
export async function settleSpecPinAtClaim(task: {
  id: string; workspaceId: string; context: Ctx; dependsOn?: unknown; taskClass?: string | null;
}, deps = taskHandoffDeps): Promise<ClaimSpecPin> {
  const reasons: string[] = [];
  let context = (task.context ?? {}) as Record<string, unknown>;
  let changed = false;

  const depIds = Array.isArray(task.dependsOn) ? task.dependsOn.filter((d): d is string => typeof d === 'string' && isUuid(d)) : [];
  if (depIds.length > 0 && task.taskClass !== 'attempt') {
    const inherit = inheritableSpec({ context }, await deps.loadDeps(depIds));
    if (inherit) {
      const own = asRecord(context.specSource) ?? {};
      const pinned = await pinSpecSource(task.workspaceId, { ...context, specSource: { ...own, specId: inherit.specId, inheritedFrom: inherit.inheritedFrom } });
      if (pinned.ok) {
        context = pinned.context as Record<string, unknown>;
        changed = true;
        reasons.push(`inherited spec ${inherit.specId} from dependency ${inherit.inheritedFrom}`);
      } else {
        reasons.push(`spec ${inherit.specId} from dependency ${inherit.inheritedFrom} not pinned: ${pinned.error}`);
      }
    }
  }

  const repin = await repinSpecAtClaim({ id: task.id, workspaceId: task.workspaceId, context, taskClass: task.taskClass });
  if (repin.specSource) {
    context = { ...context, specSource: repin.specSource };
    changed = true;
  }
  if (repin.reason) reasons.push(repin.reason);

  const pin = pinOf(context.specSource);
  const title = pin ? await deps.specTitle(pin.specId).catch(() => null) : null;
  return {
    specSource: changed ? (context.specSource as Record<string, unknown>) : null,
    reasons,
    brief: specPinBrief(context.specSource, title),
    ask: pin && shouldAskApproval(context) ? { specId: pin.specId, revision: pin.revision, title: title ?? 'a Living Spec' } : null,
  };
}
