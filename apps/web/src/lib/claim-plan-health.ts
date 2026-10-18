/**
 * Claimability on Health, read from the claim-plan ledger.
 *
 * Runner slots in use answer "what is occupied"; the claim planner's recorded
 * plans answer "what could be claimed and what the scheduler chose". They are
 * different quantities, so this summary never mentions a slot ceiling: it only
 * counts what the planner recorded (candidates, picks, tasks ordered behind
 * another, capacity it was handed at the time).
 */

export interface ClaimPlanRow {
  occurredAt: Date | string;
  detail: unknown;
}

export interface ClaimPlanHealth {
  /** Plans recorded in the window, repeats counted (a coalesced row carries its `count`). */
  plans: number;
  /** Mode of the newest recorded plan; null when none was recorded. */
  mode: 'record' | 'apply' | null;
  /** When the newest plan was last evaluated (ISO). */
  lastEvaluatedAt: string | null;
  /** Plans that ordered at least one candidate behind another. */
  plansWithOrdering: number;
  /** Plans made under claim pressure (budget or plan walls). */
  plansUnderPressure: number;
  /** Plans whose picks fell short of min(capacity, candidates): claimable work left unstarted. */
  plansLeavingClaimableWork: number;
  /** Plans recorded without a capacity (older rows); excluded from the line above. */
  plansWithoutCapacity: number;
  byBackend: { claude: number; codex: number; mixed: number };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function summarizeClaimPlans(rows: readonly ClaimPlanRow[]): ClaimPlanHealth {
  const out: ClaimPlanHealth = {
    plans: 0, mode: null, lastEvaluatedAt: null, plansWithOrdering: 0, plansUnderPressure: 0,
    plansLeavingClaimableWork: 0, plansWithoutCapacity: 0, byBackend: { claude: 0, codex: 0, mixed: 0 },
  };
  let newest = -Infinity;
  for (const r of rows) {
    const d = (r.detail && typeof r.detail === 'object' ? r.detail : {}) as Record<string, unknown>;
    const mode = d.mode === 'apply' ? 'apply' : d.mode === 'record' ? 'record' : null;
    if (!mode) continue;
    const repeat = (num(d.count) ?? 1) > 0 ? (num(d.count) ?? 1) : 1;
    const seen = Date.parse(typeof d.lastSeenAt === 'string' ? d.lastSeenAt : '') || new Date(r.occurredAt).getTime();
    if (seen > newest) {
      newest = seen;
      out.mode = mode;
      out.lastEvaluatedAt = new Date(seen).toISOString();
    }
    out.plans += repeat;
    if ((num(d.orderedBehindCount) ?? 0) > 0) out.plansWithOrdering += repeat;
    if (d.underPressure === true) out.plansUnderPressure += repeat;
    const backend = d.backend === 'codex' ? 'codex' : d.backend === 'mixed' ? 'mixed' : 'claude';
    out.byBackend[backend] += repeat;
    const capacity = num(d.capacity);
    if (capacity === null) { out.plansWithoutCapacity += repeat; continue; }
    const picked = Array.isArray(d.actual) ? d.actual.length : 0;
    if (picked < Math.min(capacity, num(d.candidateCount) ?? 0)) out.plansLeavingClaimableWork += repeat;
  }
  return out;
}
