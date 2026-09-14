/**
 * Route-side conveniences over `recordGateEvent`.
 *
 * The writer itself lives in `@buildd/core/gate-events` (it has to — the runner
 * and core helpers record gates too). What belongs here is the two things only
 * a Next.js route can answer: which door the caller came in, and how to turn a
 * caller-supplied workspace *reference* into a workspace id.
 *
 * Everything below is fire-and-forget. Nothing returns a value the request path
 * uses, and nothing rejects.
 */
import { db } from '@buildd/core/db';
import { workspaces } from '@buildd/core/db/schema';
import { eq, or } from 'drizzle-orm';
import {
  recordGateEvent,
  GATE_SLUGS,
  type GateCallerOrigin,
  type RecordGateEventInput,
} from '@buildd/core/gate-events';

export { GATE_SLUGS };
export type { GateCallerOrigin };

/**
 * Which door the call came in.
 *
 * A worker token authenticates as an API account, so `workerId` is checked
 * first — otherwise every agent-filed task would be indistinguishable from a
 * human curl, and "is this lint only firing on agents?" becomes unanswerable.
 */
export function gateCallerOrigin(input: {
  apiAccount?: unknown | null;
  user?: unknown | null;
  workerId?: string | null;
}): GateCallerOrigin {
  if (input.workerId) return 'worker';
  if (input.apiAccount) return 'api';
  if (input.user) return 'dashboard';
  return 'system';
}

/**
 * Record a gate event without awaiting it.
 *
 * `recordGateEvent` already swallows its own errors; the extra `.catch` is for
 * the pathological case where the module itself throws synchronously, which
 * would otherwise surface as an unhandled rejection in the route.
 */
export function fireGateEvent(input: RecordGateEventInput): void {
  void recordGateEvent(input).catch(() => {});
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record a gate event whose route refused BEFORE it resolved a workspace.
 *
 * The task-creation param gates (`kind`, `complexity`) fire above the workspace
 * lookup, and moving them below it would change which error a doubly-invalid
 * request gets back — a behaviour change this ledger is explicitly not allowed
 * to make. So the resolution happens here instead, in the background, where an
 * extra SELECT costs the caller nothing because nobody is waiting on it.
 *
 * A reference that does not resolve is not an error: the row still lands with a
 * null workspace and the raw reference preserved in `detail.workspaceRef`, which
 * is strictly more than the zero rows this class of refusal used to produce.
 */
export function fireGateEventForWorkspaceRef(
  workspaceRef: unknown,
  input: Omit<RecordGateEventInput, 'workspaceId'>,
): void {
  const ref = typeof workspaceRef === 'string' ? workspaceRef.trim() : '';
  if (!ref) {
    fireGateEvent(input);
    return;
  }
  void (async () => {
    let workspaceId: string | null = null;
    try {
      workspaceId = UUID_RE.test(ref) ? ref : await resolveWorkspaceIdForGate(ref);
    } catch {
      // Resolution is best-effort by construction — see above.
    }
    await recordGateEvent({
      ...input,
      workspaceId,
      detail: { ...(input.detail ?? {}), workspaceRef: ref },
    }).catch(() => {});
  })();
}

/**
 * Name/repo → workspace id, for the background path above only.
 *
 * Deliberately NOT `resolveWorkspace` from `workspace-resolver.ts`: that helper
 * is the one the route's own control flow depends on, and calling it from a
 * fire-and-forget path would make an observability write share a code path with
 * a request-critical one.
 *
 * Exact equality on either column, and no `ilike` suffix match on `owner/repo`.
 * A repo name may contain `_`, which `ilike` reads as a single-character
 * wildcard — so a pattern match here could attribute a ledger row to the wrong
 * workspace, which is worse than leaving it unattributed. `workspaces.name` is
 * the bare repo name in practice, so the common caller input still resolves.
 */
async function resolveWorkspaceIdForGate(ref: string): Promise<string | null> {
  const row = await db.query.workspaces.findFirst({
    where: or(eq(workspaces.name, ref), eq(workspaces.repo, ref)),
    columns: { id: true },
  });
  return row?.id ?? null;
}
