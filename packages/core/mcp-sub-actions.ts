/**
 * The one list of each `buildd` action's sub-actions (its `params.action`, or
 * `params.op` for consolidate_knowledge).
 *
 * Every surface that names sub-actions reads them from here: the handler's
 * validation, the group tool's signature and typed params, and the
 * scope-aware listing (an action is listed for a scoped session when any one
 * of its sub-actions is permitted). The long docs that `help` and the legacy
 * tool serve (buildParamsDescription) keep them as literal text, because
 * scripts/mcp-consumer-skill-action-drift.test.ts reads sub-action names from
 * that source; surface-parity.test.ts fails if that text and this list differ.
 * Hand-kept copies drifted before: the short docs said manage_specs had 5
 * sub-actions while the handler took 14. transport-parity.test.ts holds every
 * surface to this list.
 *
 * Imports types only, so the handler modules can import it without a cycle.
 */
import type { BuilddAction } from './mcp-tools';

export const SUB_ACTIONS = {
  manage_specs: ['create_draft', 'get', 'revise', 'list', 'relate', 'submit', 'approve', 'outcome', 'verdict', 'conflict', 'read_ref', 'diff', 'comment', 'comments', 'metadata', 'organize', 'attach_provisional', 'import', 'confirm_import', 'attach', 'attachments'],
  manage_missions: ['list', 'create', 'get', 'update', 'arm', 'delete', 'link_task', 'unlink_task', 'evaluate', 'get_criteria_state'],
  manage_initiatives: ['list', 'create', 'get', 'update', 'delete', 'link_mission', 'unlink_mission'],
  manage_workspaces: ['list', 'get', 'create', 'update', 'create_repo', 'init', 'readiness', 'scaffold', 'author_spec'],
  manage_watched_projects: ['list', 'create', 'update', 'delete', 'run'],
  manage_experiments: ['list', 'get', 'readout', 'create', 'update', 'start', 'pause', 'conclude'],
  manage_providers: ['list', 'set', 'delete', 'explain', 'set_policy'],
  manage_secrets: ['list', 'set', 'delete'],
  manage_model_tiers: ['list', 'set', 'delete', 'policy', 'set_policy', 'adopt', 'model'],
  manage_evidence_backends: ['list', 'get', 'create', 'update', 'delete', 'verify'],
  update_incident: ['acknowledge', 'resolve'],
  consolidate_knowledge: ['find_duplicates', 'find_decayed', 'archive'],
} as const satisfies Partial<Record<BuilddAction, readonly string[]>>;

export type SubActionOwner = keyof typeof SUB_ACTIONS;

/** The param that selects the sub-action: `action`, except consolidate_knowledge's `op`. */
export const SUB_ACTION_SELECTOR: Partial<Record<SubActionOwner, 'op'>> = { consolidate_knowledge: 'op' };

export function subActionsOf(action: string): readonly string[] | null {
  return Object.hasOwn(SUB_ACTIONS, action) ? SUB_ACTIONS[action as SubActionOwner] : null;
}

export function subActionSelector(action: string): 'action' | 'op' {
  return SUB_ACTION_SELECTOR[action as SubActionOwner] ?? 'action';
}

/** `a|b|c`: how signatures and param text name them. */
export const subActionAlternation = (action: SubActionOwner): string => SUB_ACTIONS[action].join('|');

/** `"a" | "b" | "c"`: how the long docs name them. */
export const subActionQuoted = (action: SubActionOwner): string => SUB_ACTIONS[action].map(s => `"${s}"`).join(' | ');
