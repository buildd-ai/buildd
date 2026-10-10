import pkg from '../../package.json';

/**
 * What code is actually RUNNING right now, read from the platform's own
 * build-time environment — never a GitHub lookup, never a database read.
 * Shared by `/api/deploy-identity` and the `deployed` block of `/api/version`
 * so the two endpoints can never disagree about what "deployed" means.
 *
 * `version` comes from a static `import ... from '../../package.json'`
 * (`resolveJsonModule`), not `readFileSync` — a runtime file read here would
 * need an `outputFileTracingIncludes` entry to survive Vercel's serverless
 * bundle trace (see the MCP route's `next.config.mjs` comment for the same
 * gotcha hit before); a static import is traced automatically.
 */
export interface DeployIdentity {
  sha: string | null;
  environment: string | null;
  deploymentId: string | null;
}

export function getDeployIdentity(): DeployIdentity {
  return {
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    environment: process.env.VERCEL_ENV ?? null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
  };
}

export const DEPLOYED_VERSION: string = pkg.version || '0.0.0';

/**
 * The execution control plane Worker's commit, beside the web app's, so one
 * read answers "do both hosts run the same code" (docs/specs/execution-control-plane.md).
 * Read from the Worker's public shallow health with a short timeout; `null`
 * when it does not answer, never a throw, so this endpoint keeps answering.
 */
export const CONTROL_PLANE_HEALTH_URL = 'https://control-plane.buildd.dev/__control-plane/health';
export const CONTROL_PLANE_TIMEOUT_MS = 1500;

export interface ControlPlaneIdentity { commit: string | null; mode: string | null }

export async function getControlPlaneIdentity(fetchImpl: typeof fetch = fetch): Promise<ControlPlaneIdentity | null> {
  try {
    const res = await fetchImpl(process.env.CONTROL_PLANE_HEALTH_URL || CONTROL_PLANE_HEALTH_URL, {
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { commit?: unknown; mode?: unknown };
    return {
      commit: typeof body.commit === 'string' ? body.commit : null,
      mode: typeof body.mode === 'string' ? body.mode : null,
    };
  } catch {
    return null;
  }
}
