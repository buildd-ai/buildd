import { registerOTel } from '@vercel/otel';

export async function register() {
  // Private policy overrides (lib/policy-overrides.ts): load once at boot so the
  // sync threshold getters see them from the first request. Node runtime only —
  // the loader reads the DB. A failure is logged inside and leaves the defaults.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.DATABASE_URL) {
    const { startPolicyOverrides } = await import('./lib/policy-overrides-source');
    await startPolicyOverrides();
  }

  // Only register OTel in deployed environments (Vercel) or when explicitly opted in.
  // Local `next dev` should not export to prod dataset; use OTEL_DEBUG=true for local debugging.
  const vercelEnv = process.env.VERCEL_ENV || process.env.OTEL_DEBUG;
  if (!vercelEnv) return;

  registerOTel({
    serviceName: 'buildd-web',
  });

  // Memory is now stored in buildd's own database (memories table).
  // No external service or env var required — reads/writes work out of the box.
  // If DATABASE_URL is missing, the db connection itself will fail loudly at startup.
}
