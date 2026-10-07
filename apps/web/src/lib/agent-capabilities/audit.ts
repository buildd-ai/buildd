/**
 * Record a capability decision about an agent run (agent_capability_decisions).
 *
 * Fire-and-forget: the write never blocks the request and never fails it. A
 * missing row costs an answer to "why was this allowed"; a failed request
 * would cost the run.
 *
 * Never pass credential material. Callers hand over ids, a capability name,
 * a resource label, the decision and a reason code; a token or key has no
 * field to go in.
 */
import { db } from '@buildd/core/db';
// A namespace import, read at call time: route tests mock the schema module
// with only the tables they touch, and a named import of a table they leave
// out would fail at load.
import * as schema from '@buildd/core/db/schema';

export type CapabilityName =
  | 'github.repo_grant'
  | 'model.endpoint'
  | 'task_token.mint'
  | 'runner.size'
  | 'pr.create'
  | 'pr.adopt'
  | 'pr.close'
  | 'pr.update_body'
  | 'pr.merge';

export interface CapabilityDecisionRecord {
  capability: CapabilityName;
  decision: 'allowed' | 'refused';
  workspaceId?: string | null;
  taskId?: string | null;
  workerId?: string | null;
  accountId?: string | null;
  principalVia?: 'dispatch' | 'runner_key' | 'task_token' | 'worker_account' | null;
  /** `github_repo:<row id>`, `pr:<number>`, `task:<id>` — a label, never a URL with credentials. */
  resource?: string | null;
  reasonCode?: string | null;
  expiresAt?: Date | null;
  sideEffect?: Record<string, unknown> | null;
}

/** Ids only: a non-id value (an unvalidated request field) is dropped rather than risk an FK failure. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: string | null | undefined) => (v && UUID_RE.test(v) ? v : null);

export function recordCapabilityDecision(row: CapabilityDecisionRecord, deps: { insert?: (values: Record<string, unknown>) => Promise<unknown> } = {}): Promise<void> {
  const values = {
    capability: row.capability,
    decision: row.decision,
    workspaceId: id(row.workspaceId),
    taskId: id(row.taskId),
    workerId: id(row.workerId),
    accountId: id(row.accountId),
    principalVia: row.principalVia ?? null,
    resource: row.resource ?? null,
    reasonCode: row.reasonCode ?? null,
    expiresAt: row.expiresAt ?? null,
    sideEffect: row.sideEffect ?? null,
  };
  const insert = deps.insert ?? ((v: Record<string, unknown>) => {
    const table = (schema as Record<string, unknown>).agentCapabilityDecisions;
    if (!table) return Promise.resolve();
    return (db as unknown as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } }).insert(table).values(v);
  });
  return Promise.resolve()
    .then(() => insert(values))
    .then(() => undefined)
    .catch((err: unknown) => {
      console.warn(`[capability-audit] could not record ${row.capability} ${row.decision}: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}`);
    });
}
