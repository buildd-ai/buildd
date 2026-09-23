/**
 * Public projection of a LocalWorker for the runner's HTTP and SSE surfaces.
 *
 * Invariant: nothing the runner serialises to a client (`/api/workers`,
 * `/api/claim`, the `/api/events` init payload, or any broadcast event) carries
 * credential material. A LocalWorker holds the credentials its session needs
 * (server-issued tokens, MCP secrets, backend credentials, presigned config
 * URLs), so it must never be handed to `JSON.stringify` / `Response.json` raw.
 *
 * This is an allowlist, not a denylist: a field is only emitted if it is listed
 * here as `true`. Fields set on a worker ad hoc (outside the LocalWorker type)
 * and fields added to the type later are withheld until someone classifies them.
 * `public-worker.test.ts` fails when LocalWorker gains a field that is not
 * classified below, so the choice is made deliberately rather than by default.
 */
import type { LocalWorker } from './types';

/** true = safe to serialise to clients; false = withheld. */
export const WORKER_FIELD_VISIBILITY: Record<keyof LocalWorker, boolean> = {
  id: true,
  taskId: true,
  taskTitle: true,
  taskDescription: true,
  taskMode: true,
  taskBackend: true,
  workspaceId: true,
  workspaceName: true,
  workspaceDataClass: true,
  branch: true,
  status: true,
  hasNewActivity: true,
  startedAt: true,
  lastActivity: true,
  toolInFlight: true,
  killedByRestart: true,
  completedAt: true,
  milestones: true,
  currentAction: true,
  commits: true,
  prCreated: true,
  prUrl: true,
  output: true,
  toolCalls: true,
  messages: true,
  sessionId: true,
  codexThreadId: true,
  error: true,
  waitingFor: true,
  teamState: true,
  subagentTasks: true,
  subagentTasksObservedCount: true,
  worktreePath: true,
  worktreeBaseRef: true,
  envDegraded: true,
  checkpoints: true,
  checkpointEvents: true,
  pendingMcpCalls: true,
  pendingErrorTraces: true,
  pendingActionEvents: true,
  pendingPromptCompositionEvents: true,
  promptBuildIndex: true,
  pendingPaths: true,
  lastAssistantMessage: true,
  tokenTally: true,
  sandboxMountGap: true,
  bwrapRetryPending: true,
  phaseText: true,
  phaseStart: true,
  phaseToolCount: true,
  phaseTools: true,
  sessionModel: true,
  reportedModel: true,
  resultMeta: true,
  cbmOutcome: true,
  cbmDisableReason: true,
  cbmBootstrapResult: true,
  cbmBootstrapFailReason: true,
  cbmBackgroundIndexLanded: true,
  cbmSharedCache: true,
  cbmSeedRefresh: true,
  cbmSeedBaseMismatch: true,
  cbmToolCounts: true,
  cbmFileAccessCounts: true,
  toolCounts: true,
  bashCommandCounts: true,
  degradedConnectors: true,
  assertionConnectors: true,
  promptSuggestions: true,
  loopNudgeSent: true,
  currentPromptId: true,
  commandLifecycle: true,
  modelCapabilities: true,

  // Credential material and credential handles — never serialised.
  mcpSecrets: false,
  serverApiKey: false,
  serverOauthToken: false,
  claudeAccessToken: false,
  claudeTokenExpiresAt: false,
  claudeCredentialId: false,
  codexCredential: false,
  roleConfig: false, // carries a presigned download URL
  assertionTokenCache: false,
  assertionReAuthFailed: false,
};

const PUBLIC_FIELDS: ReadonlyArray<keyof LocalWorker> = (
  Object.keys(WORKER_FIELD_VISIBILITY) as Array<keyof LocalWorker>
).filter((k) => WORKER_FIELD_VISIBILITY[k]);

export type PublicWorker = Partial<LocalWorker>;

/** Project a worker onto its allowlisted, client-safe fields. */
export function toPublicWorker(worker: LocalWorker): PublicWorker {
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_FIELDS) {
    const value = (worker as any)[field];
    if (value !== undefined) out[field] = value;
  }
  return out as PublicWorker;
}

export function toPublicWorkers(workers: Iterable<LocalWorker>): PublicWorker[] {
  return Array.from(workers, toPublicWorker);
}

/**
 * Project any runner event before it is broadcast to SSE clients. Events that
 * carry a `worker` (e.g. `worker_update`) or `workers` payload have those
 * projected; everything else passes through unchanged.
 */
export function toPublicEvent<T>(event: T): T {
  if (!event || typeof event !== 'object') return event;
  const e = event as any;
  const hasWorker = e.worker && typeof e.worker === 'object';
  const hasWorkers = Array.isArray(e.workers);
  if (!hasWorker && !hasWorkers) return event;
  const out = { ...e };
  if (hasWorker) out.worker = toPublicWorker(e.worker);
  if (hasWorkers) out.workers = toPublicWorkers(e.workers);
  return out;
}
