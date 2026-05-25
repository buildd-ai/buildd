export type VercelDeploymentState =
  | 'READY'
  | 'ERROR'
  | 'CANCELED'
  | 'BUILDING'
  | 'QUEUED'
  | 'INITIALIZING'
  | string;

export interface VercelDeployment {
  uid: string;
  state: VercelDeploymentState;
  created: number;
  target: string | null;
  url: string;
  inspectorUrl: string;
}

export type DeploymentHealth =
  | { status: 'healthy'; dedupeKey: null; deployment: VercelDeployment | null; reason: string }
  | { status: 'unhealthy'; dedupeKey: string; deployment: VercelDeployment; reason: string }
  | { status: 'stale'; dedupeKey: string; deployment: VercelDeployment; reason: string }
  | { status: 'unknown'; dedupeKey: null; deployment: VercelDeployment | null; reason: string };

const FAILED_STATES = new Set(['ERROR', 'CANCELED']);

/**
 * Pure evaluator: given a list of recent production deployments and a grace
 * window, decide whether to fire an alert. Splits into a separate module
 * from health-watcher.ts so it can be unit-tested without touching the DB.
 */
export function evaluateDeploymentHealth(
  raw: VercelDeployment[],
  opts: { graceMin: number; now: number },
): DeploymentHealth {
  const deployments = raw
    .filter((d) => d.target === 'production')
    .slice()
    .sort((a, b) => b.created - a.created);

  if (deployments.length === 0) {
    return { status: 'unknown', dedupeKey: null, deployment: null, reason: 'no production deployments returned' };
  }

  const latest = deployments[0];
  if (FAILED_STATES.has(latest.state)) {
    return {
      status: 'unhealthy',
      dedupeKey: `deploy-${latest.uid}`,
      deployment: latest,
      reason: `latest production deployment is ${latest.state}`,
    };
  }

  const lastReady = deployments.find((d) => d.state === 'READY') ?? null;
  if (!lastReady) {
    return {
      status: 'unknown',
      dedupeKey: null,
      deployment: latest,
      reason: 'no READY deployment in window; latest is in progress',
    };
  }

  const ageMin = (opts.now - lastReady.created) / 60_000;
  if (ageMin > opts.graceMin) {
    return {
      status: 'stale',
      dedupeKey: `stale-${lastReady.uid}`,
      deployment: lastReady,
      reason: `no READY deployment within ${opts.graceMin}m grace (last READY ${Math.round(ageMin)}m ago)`,
    };
  }

  return {
    status: 'healthy',
    dedupeKey: null,
    deployment: lastReady,
    reason: `last READY ${Math.round(ageMin)}m ago`,
  };
}

const VERCEL_API = 'https://api.vercel.com';

/**
 * Fetch recent production deployments for a project. Caller supplies the
 * Vercel token — null means the watcher should skip this row.
 */
export async function listProdDeployments(
  projectId: string,
  token: string,
  opts?: { limit?: number; teamId?: string },
): Promise<VercelDeployment[]> {
  const params = new URLSearchParams({
    projectId,
    target: 'production',
    limit: String(opts?.limit ?? 10),
  });
  if (opts?.teamId) params.set('teamId', opts.teamId);

  const res = await fetch(`${VERCEL_API}/v6/deployments?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vercel API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { deployments?: Array<Record<string, unknown>> };
  return (data.deployments ?? []).map((d) => ({
    uid: (d.uid as string) ?? '',
    state: (d.state as VercelDeploymentState) ?? 'UNKNOWN',
    created: (d.created as number) ?? 0,
    target: (d.target as string | null) ?? null,
    url: (d.url as string) ?? '',
    inspectorUrl: (d.inspectorUrl as string) ?? '',
  }));
}
