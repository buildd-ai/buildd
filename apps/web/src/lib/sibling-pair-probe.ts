/**
 * The newest live sibling probe of one (candidate, holder) pair, as claim-risk
 * evidence (`PairProbeEvidence`, packages/core/orchestration-claim-risk.ts).
 *
 * A probe is a `git merge-tree` of two branches (sibling-conflict-probe.ts), so
 * it exists only for a candidate that already has a branch (a conflict, review
 * or CI retry resuming on its PR's branch). It is evidence only while both
 * branches are still at the heads that were probed: the heads the probe
 * recorded must equal the two workers' current commit. Anything unknown makes
 * it stale, and stale evidence is ignored by the risk profile. Never throws.
 */
import type { PairProbeEvidence } from '@buildd/core/orchestration-claim-risk';
import { siblingHeadsKey, siblingPairKey } from '@/lib/sibling-conflict-probe';

export interface PairWorkerRef { taskId?: string | null; branch?: string | null }
export interface PairWorker { id: string; lastCommitSha: string | null }
export interface PairProbeEvent { occurredAt: Date; detail: Record<string, unknown> | null }

export interface PairProbeDeps {
  findWorker: (workspaceId: string, ref: PairWorkerRef) => Promise<PairWorker | null>;
  latestProbeEvent: (workspaceId: string, pairKey: string) => Promise<PairProbeEvent | null>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function pairProbeEvidence(event: PairProbeEvent | null, a: PairWorker, b: PairWorker): PairProbeEvidence | null {
  const d = event?.detail;
  const outcome = d?.probeOutcome;
  if (!event || (outcome !== 'clean' && outcome !== 'conflict' && outcome !== 'mergiraf_resolved' && outcome !== 'error')) return null;
  const probed = siblingHeadsKey(typeof d?.headSha === 'string' ? d.headSha : null, typeof d?.otherSha === 'string' ? d.otherSha : null);
  const current = siblingHeadsKey(a.lastCommitSha, b.lastCommitSha);
  return {
    outcome,
    conflictFiles: strings(d?.conflictFiles),
    probedAt: event.occurredAt.toISOString(),
    headsCurrent: !!probed && probed === current,
  };
}

export async function loadPairProbeEvidence(
  input: { workspaceId: string; candidate: PairWorkerRef; holder: PairWorkerRef },
  deps: PairProbeDeps = defaultDeps(),
): Promise<PairProbeEvidence | null> {
  try {
    if (!input.candidate.branch) return null;
    const [a, b] = await Promise.all([
      deps.findWorker(input.workspaceId, input.candidate),
      deps.findWorker(input.workspaceId, input.holder),
    ]);
    if (!a || !b || a.id === b.id) return null;
    return pairProbeEvidence(await deps.latestProbeEvent(input.workspaceId, siblingPairKey(a.id, b.id)), a, b);
  } catch (err) {
    console.warn('[claim] pair probe lookup failed (ignored):', (err as Error)?.message ?? err);
    return null;
  }
}

function defaultDeps(): PairProbeDeps {
  return {
    async findWorker(workspaceId, ref) {
      const [{ db }, { workers }, { and, desc, eq }] = await Promise.all([
        import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
      ]);
      const where = ref.branch
        ? and(eq(workers.workspaceId, workspaceId), eq(workers.branch, ref.branch))
        : ref.taskId ? and(eq(workers.workspaceId, workspaceId), eq(workers.taskId, ref.taskId)) : null;
      if (!where) return null;
      const [row] = await db.select({ id: workers.id, lastCommitSha: workers.lastCommitSha })
        .from(workers).where(where).orderBy(desc(workers.createdAt)).limit(1);
      return row ?? null;
    },
    async latestProbeEvent(workspaceId, pairKey) {
      const [{ db }, { gateEvents }, { GATE_SLUGS }, { and, desc, eq, sql }] = await Promise.all([
        import('@buildd/core/db'), import('@buildd/core/db/schema'), import('@buildd/core/gate-events'), import('drizzle-orm'),
      ]);
      const [row] = await db.select({ occurredAt: gateEvents.occurredAt, detail: gateEvents.detail })
        .from(gateEvents)
        .where(and(
          eq(gateEvents.workspaceId, workspaceId),
          eq(gateEvents.gate, GATE_SLUGS.SIBLING_CONFLICT_PROBE),
          sql`${gateEvents.detail}->>'pairKey' = ${pairKey}`,
        ))
        .orderBy(desc(gateEvents.occurredAt)).limit(1);
      return row ?? null;
    },
  };
}
