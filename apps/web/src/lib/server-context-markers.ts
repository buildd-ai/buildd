/**
 * Context markers only the server writes for a mission's outcome spec
 * (Living Specs Slice 12). `finalVerification` lets a task's token record
 * mission-level verdicts and keeps it out of build counts; `specRepair` keeps
 * a repair out of build counts. A caller's copy of either is dropped on every
 * create path and every template, like the review system's own keys
 * (lib/verdict-provenance.ts): the final verification is filed by
 * `ensureFinalVerification`, and a repair is stamped only when the mission's
 * own final verification task files it (`specRepairStamp`).
 */

export const MISSION_VERIFICATION_CONTEXT_KEYS = ['finalVerification', 'specRepair'] as const;

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

/**
 * The `specRepair` marker a new task gets, or null. Only when the filer is
 * the final verification task of the same mission the new task is filed in;
 * the criterion id is taken from the request when it names one.
 */
export function specRepairStamp(input: {
  requested: unknown;
  missionId: string | null | undefined;
  filerTaskId: string | null | undefined;
  filerTask: { missionId: string | null; context: unknown } | null | undefined;
}): { missionId: string; criterionId?: string; filedBy: string } | null {
  const { missionId, filerTask, filerTaskId } = input;
  if (!missionId || !filerTask || !filerTaskId || filerTask.missionId !== missionId) return null;
  const marker = (filerTask.context as Record<string, unknown> | null)?.finalVerification as { missionId?: unknown } | undefined;
  if (!marker || marker.missionId !== missionId) return null;
  const req = input.requested && typeof input.requested === 'object' ? (input.requested as Record<string, unknown>) : null;
  const criterionId = typeof req?.criterionId === 'string' && /^(R|AC)-\d+$/.test(req.criterionId) ? req.criterionId : undefined;
  return { missionId, ...(criterionId ? { criterionId } : {}), filedBy: filerTaskId };
}
