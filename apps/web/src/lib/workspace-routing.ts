/**
 * The one place a new task's home workspace is chosen
 * (docs/specs/workspace-routing-and-reach.md §4, I-13/I-14).
 *
 * Order, first that applies wins: explicit, subject, source object,
 * schedule / mission, caller default. The answer records why, and is stored
 * on the task as `context.workspaceRouting` so an approval card and an
 * auditor can read it back.
 *
 * Pure: callers resolve references (names, repos) to workspace ids first.
 * Reach is NOT decided here. A subject that points at a workspace the caller
 * cannot file in is answered by the caller's reach check as
 * `delegation_required` naming that workspace; this resolver's job is that the
 * caller's own home is never silently used instead (I-14).
 */

export const WORKSPACE_ROUTING_CONTEXT_KEY = 'workspaceRouting';

export const WORKSPACE_ROUTING_SOURCES = [
  'explicit',
  'subject',
  'source',
  'schedule',
  'mission',
  'caller_default',
] as const;
export type WorkspaceRoutingSource = (typeof WORKSPACE_ROUTING_SOURCES)[number];

export interface WorkspaceRouting {
  workspaceId: string;
  source: WorkspaceRoutingSource;
  reason: string;
}

export interface WorkspaceRoutingInput {
  /** The caller named a workspace. */
  explicit?: { workspaceId: string; ref?: string } | null;
  /** What the task is about: the workspace whose repo/data it reads or changes. */
  subject?: { workspaceId: string; ref?: string } | null;
  /** The object this task continues (retry, repair, review, plan step, criterion). */
  sourceObject?: { workspaceId: string; kind: string } | null;
  schedule?: { workspaceId: string | null | undefined } | null;
  mission?: { workspaceId: string | null | undefined } | null;
  /** The caller's own home. */
  callerDefault?: { workspaceId: string; reason?: string } | null;
}

export type WorkspaceRoutingResult =
  | { ok: true; routing: WorkspaceRouting }
  | { ok: false; error: 'no_workspace' };

export function resolveTaskWorkspace(input: WorkspaceRoutingInput): WorkspaceRoutingResult {
  const { explicit, subject, sourceObject, schedule, mission, callerDefault } = input;
  if (explicit?.workspaceId) {
    return pick(explicit.workspaceId, 'explicit', `the caller named ${explicit.ref ?? 'this workspace'}`);
  }
  if (subject?.workspaceId) {
    return pick(subject.workspaceId, 'subject', `the task is about ${subject.ref ?? 'this workspace'}`);
  }
  if (sourceObject?.workspaceId) {
    return pick(sourceObject.workspaceId, 'source', `it continues a ${sourceObject.kind}, which lives here`);
  }
  if (schedule?.workspaceId) return pick(schedule.workspaceId, 'schedule', "it is the schedule's workspace");
  if (mission?.workspaceId) return pick(mission.workspaceId, 'mission', "it is the mission's workspace");
  if (callerDefault?.workspaceId) {
    return pick(callerDefault.workspaceId, 'caller_default', callerDefault.reason ?? "no workspace or subject was given, so the caller's own workspace");
  }
  return { ok: false, error: 'no_workspace' };
}

function pick(workspaceId: string, source: WorkspaceRoutingSource, reason: string): WorkspaceRoutingResult {
  return { ok: true, routing: { workspaceId, source, reason } };
}

/**
 * Stamp the routing on a task context. The server's value wins over anything
 * a caller put under the same key.
 */
export function withWorkspaceRouting<T extends Record<string, unknown> | null | undefined>(
  context: T,
  routing: WorkspaceRouting,
): Record<string, unknown> {
  return { ...(context ?? {}), [WORKSPACE_ROUTING_CONTEXT_KEY]: routing };
}

/** A caller's own copy of the key is dropped: the resolver is the only writer. */
export function withoutWorkspaceRouting<T>(context: T): T {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  const { [WORKSPACE_ROUTING_CONTEXT_KEY]: _dropped, ...rest } = context as Record<string, unknown>;
  return rest as T;
}

/** Resolver for a path with a fixed, already-known home (a system filer, a retry). */
export function routedFrom(
  workspaceId: string,
  source: WorkspaceRoutingSource,
  reason: string,
): WorkspaceRouting {
  return { workspaceId, source, reason };
}
