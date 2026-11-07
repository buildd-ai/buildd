/**
 * The `gitConfig.mergePolicy.reviewByRisk` setting's shape (spec 62e985a8): its
 * area names, which areas are empty, and who may write it. Pure, no merge
 * behaviour: the core workspace routes and the core settings page read it. The
 * hold itself stays in the reviews module (review-by-risk.ts).
 */
import {
  REVIEW_BY_RISK_PATH_AREAS,
  type ReviewByRiskArea,
  type ReviewByRiskPathArea,
  type ReviewByRiskPolicy,
} from '@buildd/shared';

export const REVIEW_BY_RISK_AREA_LABEL: Record<ReviewByRiskArea, string> = {
  access: 'Access',
  credentials: 'Credentials',
  dataMigrations: 'Data migrations',
  acceptanceTests: 'Acceptance tests',
};

export const REVIEW_BY_RISK_AREA_WHAT: Record<ReviewByRiskArea, string> = {
  access: 'sign-in, sessions, team roles, permissions, token scopes',
  credentials: 'secrets, API keys, model logins, their storage and injection',
  dataMigrations: 'schema changes and migration files',
  acceptanceTests: 'adding, changing or deleting a test named with an AC id, or a check: line',
};

/** The path areas a workspace lists nothing for: nothing waits for a person there (R-5), and the merge policy page says so. */
export function emptyRiskAreas(policy: ReviewByRiskPolicy | null | undefined): ReviewByRiskPathArea[] {
  return REVIEW_BY_RISK_PATH_AREAS.filter((a) => !(policy?.areas?.[a] ?? []).some((p) => p.trim()));
}

// ── Who may change it (R-5, R-9) ────────────────────────────────────────────

const sameSetting = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A write of `gitConfig.mergePolicy` as review by risk sees it. A policy
 * written with no `reviewByRisk` key keeps the stored one (a form or agent
 * saving the tier does not turn the mode off). Changing it, turning it on or
 * off or editing an area's paths, is a person's act: `byPerson` is a signed-in
 * session in the browser, never an API key, a task token or an MCP session.
 * Clearing the whole policy (`null`) clears it too, so that is refused to
 * anyone else while a setting is stored.
 */
export function applyReviewByRiskWrite(args: {
  previous: unknown;
  next: unknown;
  byPerson: boolean;
}): { ok: true; next: unknown } | { ok: false; status: 403; error: string } {
  const prev = args.previous && typeof args.previous === 'object' ? (args.previous as { reviewByRisk?: unknown }).reviewByRisk : undefined;
  let next = args.next;
  if (next && typeof next === 'object' && !Array.isArray(next) && !('reviewByRisk' in next) && prev !== undefined) {
    next = { ...(next as Record<string, unknown>), reviewByRisk: prev };
  }
  const nextValue = next && typeof next === 'object' ? (next as { reviewByRisk?: unknown }).reviewByRisk : undefined;
  if (!args.byPerson && !sameSetting(prev, nextValue)) {
    return {
      ok: false,
      status: 403,
      error: 'mergePolicy.reviewByRisk can only be changed by a person, signed in on the workspace Merge Policy page; an agent, API key or MCP session cannot turn review by risk on or off or edit its risk areas.',
    };
  }
  return { ok: true, next };
}
