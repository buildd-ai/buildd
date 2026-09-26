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
