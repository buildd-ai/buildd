/**
 * The landing escape hatch's authority (workflow-state-kernel.md §13.7
 * deviation 3): merging past base freshness or the size cap is a person's call.
 * A person makes it directly (the landing page's "Merge anyway", `merge_pr`
 * from an OAuth MCP session, chat). An agent run makes it only when a person
 * put it in the run's task goal, as a structured grant on the task:
 *
 *   context.landingOverride = { prNumbers: [42], overrides: ['freshness'] }
 *
 * Only a person may set the grant, at task creation; the server stamps
 * `grantedBy` with that person and ignores any caller-supplied value. Nothing
 * reads a grant out of the description: prose is never authority. A granted
 * run may override only the named PRs and only the named kinds, never the
 * review verdict, and never red CI or a deny path (no override does).
 */

export type LandingOverrideKind = 'freshness' | 'size';
export const LANDING_OVERRIDE_KINDS: readonly LandingOverrideKind[] = ['freshness', 'size'];

export interface LandingOverrideGrant {
  prNumbers: number[];
  overrides: LandingOverrideKind[];
  /** `human:<userId>`, stamped by the server at creation. */
  grantedBy: string;
  grantedAt: string;
}

type Stamped = { ok: true; context: unknown } | { ok: false; status: 400 | 403; error: string };

/**
 * Validate and stamp `context.landingOverride` on a task being created.
 * `personId` is the person behind the request (a dashboard/chat session or an
 * OAuth MCP session), or null for any API key or per-task token.
 */
export function stampLandingOverrideGrant(context: unknown, personId: string | null, now: Date = new Date()): Stamped {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return { ok: true, context };
  const ctx = context as Record<string, unknown>;
  if (!('landingOverride' in ctx) || ctx.landingOverride == null) return { ok: true, context };
  if (!personId) {
    return {
      ok: false, status: 403,
      error: 'context.landingOverride is a person\'s grant: only a person (the dashboard, chat, or an OAuth MCP session) may set it when creating a task',
    };
  }
  const raw = ctx.landingOverride as Record<string, unknown>;
  const prNumbers = Array.isArray(raw?.prNumbers) ? raw.prNumbers : null;
  const overrides = Array.isArray(raw?.overrides) ? raw.overrides : null;
  if (!prNumbers || prNumbers.length === 0 || prNumbers.length > 20 || !prNumbers.every((n) => Number.isInteger(n) && (n as number) > 0)) {
    return { ok: false, status: 400, error: 'context.landingOverride.prNumbers must list 1-20 PR numbers' };
  }
  if (!overrides || overrides.length === 0 || !overrides.every((k) => LANDING_OVERRIDE_KINDS.includes(k as LandingOverrideKind))) {
    return { ok: false, status: 400, error: `context.landingOverride.overrides must name one or more of: ${LANDING_OVERRIDE_KINDS.join(', ')} (a verdict override is never grantable)` };
  }
  const grant: LandingOverrideGrant = {
    prNumbers: [...new Set(prNumbers as number[])],
    overrides: [...new Set(overrides as LandingOverrideKind[])],
    grantedBy: `human:${personId}`,
    grantedAt: now.toISOString(),
  };
  return { ok: true, context: { ...ctx, landingOverride: grant } };
}

/**
 * A context copied from a template (a schedule's task template, a mission's
 * schedule) with any landing grant removed. A grant is a person's call on one
 * task at its creation; a template spawns tasks unattended, so it never carries one.
 */
export function withoutLandingOverrideGrant<T extends Record<string, unknown> | null | undefined>(context: T): T {
  if (!context || typeof context !== 'object' || !('landingOverride' in context)) return context;
  const { landingOverride: _dropped, ...rest } = context as Record<string, unknown>;
  return rest as T;
}

/** The grant a task's context carries, or null when it carries none a person stamped. */
export function readLandingOverrideGrant(context: unknown): LandingOverrideGrant | null {
  const raw = (context as { landingOverride?: Partial<LandingOverrideGrant> } | null | undefined)?.landingOverride;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.grantedBy !== 'string' || !raw.grantedBy.startsWith('human:')) return null;
  if (!Array.isArray(raw.prNumbers) || !Array.isArray(raw.overrides)) return null;
  const overrides = raw.overrides.filter((k): k is LandingOverrideKind => LANDING_OVERRIDE_KINDS.includes(k as LandingOverrideKind));
  return { prNumbers: raw.prNumbers.filter((n) => Number.isInteger(n)), overrides, grantedBy: raw.grantedBy, grantedAt: String(raw.grantedAt ?? '') };
}

/**
 * May an agent run whose task carries `context` override `kinds` on `prNumber`?
 * The refusal names what is missing, so the run can report it instead of retrying.
 */
export function grantAllows(
  context: unknown,
  prNumber: number,
  kinds: LandingOverrideKind[],
): { ok: true; grant: LandingOverrideGrant } | { ok: false; reason: string } {
  const grant = readLandingOverrideGrant(context);
  if (!grant) {
    return { ok: false, reason: 'an agent run may not override landing rails unless a person granted it on its task (context.landingOverride, set when the task was created); ask the owner to merge, or to file the task with that grant' };
  }
  if (!grant.prNumbers.includes(prNumber)) {
    return { ok: false, reason: `this task's landing grant covers PR ${grant.prNumbers.map((n) => `#${n}`).join(', ')}, not #${prNumber}` };
  }
  const missing = kinds.filter((k) => !grant.overrides.includes(k));
  if (missing.length) return { ok: false, reason: `this task's landing grant does not cover the ${missing.join(' and ')} override` };
  return { ok: true, grant };
}
