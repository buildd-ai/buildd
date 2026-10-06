/**
 * A role for a task that was filed without one, from its kind.
 *
 * Most tasks are created through MCP or by fix attempts that inherit their
 * parent's (empty) role, so without this they run unrouted: no persona, and
 * their time shows as "unassigned". The decision model (task-role-apply.ts)
 * can pick a better role, but it often declines to write (below threshold, an
 * unmeasured model, no inference key), so this is the floor under it:
 *
 *   - a stated role always wins, and is never replaced;
 *   - only `work` rows, and only kinds with an obvious owner (below);
 *   - only when that role is a routing candidate in the workspace (enabled,
 *     not opt-in, tools and backend allow it: `filterRoleCandidates`), so the
 *     default can never route a task somewhere no runner would take it.
 *
 * The role is stamped `context.roleInferred` with `source: 'kind'`: the claim
 * route treats it like any inferred role (it changes who does the work, not
 * the model), and the decision model may still overwrite it while the task is
 * unclaimed (dbWriteInferredRole).
 */
import { EXPLICIT_ROLE_SLUGS } from '@buildd/shared';
import type { RoleInferredStamp } from './task-role-apply';
import { readRoleRouting } from './role-routing';
import { resolveEffectiveRoles, roleCanChangeFiles, type CandidateTask, type RoleRow } from './task-role-decision';

/** Kinds with one obvious default owner. design and observation have none. */
export const KIND_DEFAULT_ROLE: Readonly<Record<string, string>> = Object.freeze({
  engineering: 'builder',
  research: 'researcher',
  writing: 'writer',
  analysis: 'analyst',
  coordination: 'organizer',
});

export interface KindDefaultInput {
  statedRoleSlug: string | null | undefined;
  kind: string | null | undefined;
  taskClass: string;
  /** Routing candidates in this workspace (filterRoleCandidates). */
  candidates: ReadonlyArray<{ slug: string }>;
}

export function kindDefaultRole(input: KindDefaultInput): string | null {
  if (input.statedRoleSlug) return null;
  if (input.taskClass !== 'work' || !input.kind) return null;
  const slug = KIND_DEFAULT_ROLE[input.kind];
  if (!slug) return null;
  return input.candidates.some(c => c.slug === slug) ? slug : null;
}

/**
 * The roles a kind default may pick: the structural filters of
 * `filterRoleCandidates` (enabled, not opt-in, routing not disabled, tools and
 * backend allow the task), without its `whenToUse` requirement. That text is
 * what the decision model chooses by; a fixed kind -> role map does not need it,
 * and older workspaces' roles often predate it.
 */
export function kindDefaultCandidates(rows: readonly RoleRow[], task: CandidateTask): Array<{ slug: string }> {
  // Workspace override wins over the team default, as for the decision model.
  const effective = resolveEffectiveRoles(rows, task.workspaceId);
  const needsWrite = !task.emitsPlan && (task.outputRequirement === 'pr_required' || task.pathManifestIsConcrete);
  return effective
    .filter(r => r.isRole && r.enabled && !EXPLICIT_ROLE_SLUGS.includes(r.slug))
    .filter(r => !readRoleRouting(r.metadata)?.disabled)
    .filter(r => !needsWrite || roleCanChangeFiles(r.allowedTools))
    .filter(r => !(r.defaultBackend && task.backend && r.defaultBackend !== task.backend))
    .map(r => ({ slug: r.slug }));
}

export function kindDefaultStamp(slug: string, candidates: number, now: Date = new Date()): RoleInferredStamp {
  return { slug, source: 'kind', confidence: 0, model: 'kind-default', candidates, at: now.toISOString() };
}
