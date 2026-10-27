/**
 * Context markers only the server writes for a mission's outcome spec
 * (Living Specs Slice 12). `finalVerification` lets a task's token record
 * mission-level verdicts and keeps it out of build counts; `specRepair` keeps
 * a repair out of build counts. A caller's copy of either is dropped on every
 * create path and every template, like the review system's own keys
 * (lib/verdict-provenance.ts): the final verification is filed by
 * `ensureFinalVerification`, and a repair is stamped only when the mission's
 * own final verification task files it (`specRepairStamp`). `specCriterionBatch`
 * is a mission's criterion-check run, which the runner executes with no agent
 * (lib/specs/criterion-checks.ts inserts it directly, never through a route).
 */

export const MISSION_VERIFICATION_CONTEXT_KEYS = ['finalVerification', 'specRepair', 'acceptanceTests', 'specCriterionBatch'] as const;

/**
 * Context keys only the release flow writes. `releaseCandidateFix` is stamped
 * by the CI-retry path when it files the dev-side fix for a red release
 * candidate (lib/release-candidate-ci.ts, inserted directly, never through a
 * create route); `releaseCandidateAmendPr` is the amendment's compare-and-set
 * marker (lib/release/candidate-amend.ts). A caller's copy is dropped on the
 * same create paths as the outcome-spec markers.
 */
export const RELEASE_CANDIDATE_CONTEXT_KEYS = ['releaseCandidateFix', 'releaseCandidateAmendPr'] as const;

/** Every context key a caller-supplied context may not carry into a new task. */
export const SERVER_OWNED_CONTEXT_KEYS = [...MISSION_VERIFICATION_CONTEXT_KEYS, ...RELEASE_CANDIDATE_CONTEXT_KEYS] as const;

/**
 * `context` without the server-only markers (outcome-spec and release-candidate
 * keys, SERVER_OWNED_CONTEXT_KEYS); anything else passes through unchanged.
 */
export function withoutMissionVerificationMarkers<T>(context: T): T {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  const ctx = context as Record<string, unknown>;
  if (!SERVER_OWNED_CONTEXT_KEYS.some((k) => k in ctx)) return context;
  const rest: Record<string, unknown> = { ...ctx };
  for (const k of SERVER_OWNED_CONTEXT_KEYS) delete rest[k];
  return rest as T;
}

/** What a spec repair carries: the spec and criterion it repairs, and the verification that filed it. */
export interface SpecRepairMarker {
  missionId: string;
  /** Absent only on repairs filed before it was recorded, or by a verification that predates `finalVerification.specId`. */
  specId?: string;
  criterionId: string;
  filedBy: string;
}

/**
 * The `specRepair` marker a new task gets. null when the filer is not the
 * final verification task of the same mission the new task is filed in (the
 * task is not a repair). A repair names the criterion it repairs
 * (`context.specRepair.criterionId`) or is refused; the spec is the one the
 * filing verification checks (its own marker), so a caller cannot point a
 * repair at another spec. Repairs stamped before either was recorded keep
 * their marker as written: readers treat both as optional.
 */
export function specRepairStamp(input: {
  requested: unknown;
  missionId: string | null | undefined;
  filerTaskId: string | null | undefined;
  filerTask: { missionId: string | null; context: unknown } | null | undefined;
}): { ok: true; marker: SpecRepairMarker } | { ok: false; reason: string } | null {
  const { missionId, filerTask, filerTaskId } = input;
  if (!missionId || !filerTask || !filerTaskId || filerTask.missionId !== missionId) return null;
  const fv = (filerTask.context as Record<string, unknown> | null)?.finalVerification as { missionId?: unknown; specId?: unknown } | undefined;
  if (!fv || fv.missionId !== missionId) return null;
  const req = input.requested && typeof input.requested === 'object' ? (input.requested as Record<string, unknown>) : null;
  const criterionId = typeof req?.criterionId === 'string' && /^(R|AC)-\d+$/.test(req.criterionId) ? req.criterionId : null;
  if (!criterionId) {
    return { ok: false, reason: 'A task filed by the mission\'s final verification is a spec repair: pass context.specRepair: { missionId, specId, criterionId } naming the criterion it repairs (R-n or AC-n)' };
  }
  const own = typeof fv.specId === 'string' ? fv.specId : null;
  const named = typeof req?.specId === 'string' ? req.specId : null;
  if (own && named && named !== own) {
    return { ok: false, reason: `context.specRepair.specId must be the spec this verification checks (${own})` };
  }
  const specId = own ?? named;
  return { ok: true, marker: { missionId, ...(specId ? { specId } : {}), criterionId, filedBy: filerTaskId } };
}
