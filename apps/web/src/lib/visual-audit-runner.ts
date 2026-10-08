/**
 * Is a browser-capable runner online for a workspace? Pure; safe on the client.
 * (docs/design/visual-qa-human-review.md, "Runner availability".)
 *
 * The visual-auditor role is claimable only by a runner that advertises the
 * slug, and a runner advertises it only when env-scan reports
 * CAPABILITY_BROWSER. So an audit pending with no such runner online will sit
 * there indefinitely; this says so. Display only: it never cancels anything.
 *
 * The heartbeats are loaded by `loadBrowserRunnerHeartbeats`
 * (runner-heartbeats.ts), which resolves `workspaceIds` with the claim rule
 * (`accountReachesWorkspace`): the stored `worker_heartbeats.workspace_ids`
 * column is deprecated and always empty.
 */
import { CAPABILITY_BROWSER, runnerFleetIdentity, type WorkspaceExecutor } from '@buildd/shared';
import { isRunnerOnline } from './runner-heartbeats-shared';

export interface BrowserRunnerHeartbeat {
  /** The runner's account, when the loader knows it (GET /api/workers/active matches rows on it). */
  accountId?: string;
  localUiUrl?: string;
  lastHeartbeatAt: string | Date;
  environment: { envKeys?: string[] | null; fleet?: unknown } | null;
  /** Workspaces this runner's account can claim in. */
  workspaceIds: readonly string[];
}

/** Same executor rule as the claim route; legacy standing runners are hosts. */
export function browserRunnerMatchesExecutor(hb: Pick<BrowserRunnerHeartbeat, 'localUiUrl' | 'environment'>, executor: WorkspaceExecutor): boolean {
  return executor === 'any' || (runnerFleetIdentity({ localUiUrl: hb.localUiUrl ?? '', environment: hb.environment }).executor ?? 'host') === executor;
}

/** A fresh heartbeat whose account covers the workspace and whose envKeys include `browser`. */
export function browserRunnerOnline(heartbeats: readonly BrowserRunnerHeartbeat[], workspaceId: string, now: number, executor: WorkspaceExecutor = 'any'): boolean {
  return heartbeats.some(hb =>
    browserRunnerMatchesExecutor(hb, executor)
    && isRunnerOnline(hb.lastHeartbeatAt, now)
    && hb.workspaceIds.includes(workspaceId)
    && (hb.environment?.envKeys ?? []).includes(CAPABILITY_BROWSER));
}
