/**
 * Fetch Claude OAuth budget usage from the Anthropic usage endpoint.
 *
 * Undocumented endpoint — may break. Designed to be fire-and-forget:
 * returns null on any failure so callers can proceed without budget data.
 */
import { decryptTenantSecret, type EncryptedSecret } from '@buildd/core/tenant-crypto';

export interface BudgetUsage {
  session: { percent: number; resets_at: string };
  weekly: { percent: number; resets_at: string };
}

export async function fetchClaudeBudgetUsage(
  encryptedOauthToken: EncryptedSecret,
): Promise<BudgetUsage | null> {
  try {
    const accessToken = decryptTenantSecret(encryptedOauthToken);

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const data = await res.json();

    // Validate expected shape
    if (
      data?.session?.percent != null &&
      data?.weekly?.percent != null
    ) {
      return {
        session: {
          percent: data.session.percent,
          resets_at: data.session.resets_at,
        },
        weekly: {
          percent: data.weekly.percent,
          resets_at: data.weekly.resets_at,
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}
