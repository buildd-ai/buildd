/**
 * Local Neon HTTP override — lets the unchanged `drizzle-orm/neon-http` client
 * talk to a plain local Postgres through a Neon HTTP proxy
 * (scripts/demo/docker-compose.yml runs one).
 *
 * Opt-in via NEON_LOCAL_FETCH_ENDPOINT (e.g. http://127.0.0.1:54444/sql). When it
 * is unset this module does nothing, so production behaviour is untouched.
 *
 * Fails closed: when the override is requested, BOTH the fetch endpoint and the
 * DATABASE_URL host must be loopback. A local proxy in front of a remote database
 * URL would be a way to point demo tooling at a real database, so it throws
 * instead of connecting.
 */
import { neonConfig } from '@neondatabase/serverless';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Throws unless `url` parses and its host is loopback. */
export function assertLoopbackUrl(label: string, url: string | undefined): URL {
  if (!url) throw new Error(`[neon-local] ${label} is not set`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[neon-local] ${label} is not a valid URL`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `[neon-local] refusing to run: ${label} host "${parsed.hostname}" is not localhost/127.0.0.1`,
    );
  }
  return parsed;
}

let applied = false;

/**
 * Apply the override if NEON_LOCAL_FETCH_ENDPOINT is set. Returns true when the
 * override is active. Idempotent.
 */
export function applyNeonLocalOverride(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const endpoint = env.NEON_LOCAL_FETCH_ENDPOINT;
  if (!endpoint) return false;
  assertLoopbackUrl('NEON_LOCAL_FETCH_ENDPOINT', endpoint);
  assertLoopbackUrl('DATABASE_URL', env.DATABASE_URL);
  if (!applied) {
    neonConfig.fetchEndpoint = () => endpoint;
    applied = true;
  }
  return true;
}
