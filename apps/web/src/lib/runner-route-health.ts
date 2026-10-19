/**
 * The route a runner's model calls take, and where its credential comes from,
 * for the runner detail (Living Spec "Runner capacity: personal and team
 * usage", R-11, AC-8).
 *
 * Read from what the runner itself reported on its heartbeat, never from a
 * task's requested backend or from stored credentials: Health is not a
 * capability broker. Only a label travels, never a secret. Local login
 * readiness is one signal here; whether a team API key is available is a
 * separate, server-side eligibility signal this view does not claim to know.
 *
 * Client-safe: imported by a client component, so no DB.
 */

import { isRecordedModelRoute, type RecordedModelRoute, type RunnerCodexAuthSource, type RunnerModelAuthSource } from '@buildd/shared';

export type RouteState = 'ready' | 'unavailable' | 'unknown';

export interface RunnerRouteRow {
  label: string;
  /** Credential type/source in plain words. */
  source: string;
  /** ready = reported usable; unavailable = reported absent; unknown = never reported. */
  state: RouteState;
}

export interface RunnerRouteInput {
  modelAuthSource?: RunnerModelAuthSource | null;
  codexAuthSource?: RunnerCodexAuthSource | null;
  /** Recorded route of recent runs on this runner (FleetRunner.routes); words outside the known set are dropped. */
  recentRoutes?: readonly { route: string; count: number }[] | null;
}

export interface TaskRouteRow {
  route: RecordedModelRoute;
  /** Where the run's model access came from, in plain words. */
  source: string;
  count: number;
}

const TASK_ROUTE_TEXT: Record<RecordedModelRoute, string> = {
  anthropic_api_key: 'A team API key (billed per token)',
  agent_endpoint: 'A team model endpoint (gateway)',
  oauth_seat: 'A plan login on the runner (not billed per token)',
  runner_provider: "This runner's own model provider",
  cloud_egress: 'Managed cloud model access',
};

/** The route each recent task run was set up with, as recorded at claim; empty when none was. */
export function taskRouteRows(routes: RunnerRouteInput['recentRoutes']): TaskRouteRow[] {
  return (routes ?? []).flatMap(r => isRecordedModelRoute(r.route) && r.count > 0 ? [{ route: r.route, source: TASK_ROUTE_TEXT[r.route], count: r.count }] : []);
}

export function claudeRouteRow(source: RunnerModelAuthSource | null | undefined): RunnerRouteRow {
  switch (source) {
    case 'machine_login': return { label: 'Claude', source: "This machine's Claude login (plan, not billed per token)", state: 'ready' };
    case 'machine_token': return { label: 'Claude', source: 'A Claude token set on this machine (plan, not billed per token)', state: 'ready' };
    case 'api_key': return { label: 'Claude', source: 'An API key on this machine (billed per token)', state: 'ready' };
    case 'none': return { label: 'Claude', source: 'No local login or key', state: 'unavailable' };
    default: return { label: 'Claude', source: 'Not reported by this runner', state: 'unknown' };
  }
}

/** Codex is optional: not reported and `none` both read as not set up, but `none` is a report. */
export function codexRouteRow(source: RunnerCodexAuthSource | null | undefined): RunnerRouteRow {
  switch (source) {
    case 'machine_login': return { label: 'Codex', source: "This machine's Codex login", state: 'ready' };
    case 'api_key': return { label: 'Codex', source: 'An OpenAI API key on this machine (billed per token)', state: 'ready' };
    case 'none': return { label: 'Codex', source: 'No local login or key', state: 'unavailable' };
    default: return { label: 'Codex', source: 'Not reported by this runner', state: 'unknown' };
  }
}

export interface RunnerRouteDetail {
  rows: RunnerRouteRow[];
  /** Recorded per-task routes (recent runs), apart from what the runner itself reports in `rows`. */
  taskRoutes: TaskRouteRow[];
  /** Why this is only the local half of the picture. */
  note: string;
}

export function runnerRouteDetail(hb: RunnerRouteInput): RunnerRouteDetail {
  const taskRoutes = taskRouteRows(hb.recentRoutes);
  return {
    rows: [claudeRouteRow(hb.modelAuthSource), codexRouteRow(hb.codexAuthSource)],
    taskRoutes,
    note: taskRoutes.length > 0
      ? 'Logins are what the runner reported on its last check-in. Recent task routes are what each claim recorded, so a team key or gateway shows there.'
      : "Reported by the runner on its last check-in. A team API key or gateway is chosen per task; none was recorded for this runner's recent runs.",
  };
}
