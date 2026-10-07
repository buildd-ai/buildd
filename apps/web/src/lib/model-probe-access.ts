import { platformAdminAccountIds } from '@/lib/platform-admin';

/**
 * Which runners may certify models for every team (packages/core/model-certification.ts).
 *
 * A probe result is Buildd-wide: a certified model becomes eligible for every
 * latest-compatible team. So probing is limited to accounts the operator names
 * in `BUILDD_MODEL_PROBE_ACCOUNT_IDS` (comma-separated), plus the platform
 * admin accounts. Unset = no probes run, and new releases wait exactly as they
 * did before certification existed (fail closed, never open).
 */
export const MODEL_PROBE_ENV = 'BUILDD_MODEL_PROBE_ACCOUNT_IDS';

export function isModelProbeAccount(
  accountId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!accountId) return false;
  const listed = (env[MODEL_PROBE_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return listed.includes(accountId) || platformAdminAccountIds(env).has(accountId);
}

/** Dotted numeric version, as runners report `claudeCliVersion`. */
export const CLI_VERSION_RE = /^\d+\.\d+\.\d+$/;
