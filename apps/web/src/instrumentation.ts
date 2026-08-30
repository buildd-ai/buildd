import { registerOTel } from '@vercel/otel';

export function register() {
  registerOTel({ serviceName: 'buildd-web' });

  // Memory service health check — surface misconfiguration at startup rather than silently
  // returning empty results. Per-team keys are provisioned from MEMORY_ROOT_KEY on first use;
  // MEMORY_API_URL is required for any memory operation to work.
  if (!process.env.MEMORY_API_URL) {
    console.warn('[memory] MEMORY_API_URL is not set — memory features (workspace tile, dashboard page, claim_task context injection) will silently return empty. Set MEMORY_API_URL in Doppler buildd/prd+stg+dev.');
  } else if (!process.env.MEMORY_ROOT_KEY) {
    console.warn('[memory] MEMORY_ROOT_KEY is not set — auto-provisioning new team keys will fail. Teams without an existing memoryApiKey will get no memory context.');
  }
}
