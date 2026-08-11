/**
 * Periodic sweep for idle credential refresh.
 *
 * Tracks credentials seen in claim responses and proactively refreshes any
 * that will expire within 2 hours. Fires every 30 minutes — consistent with
 * other long-interval ticks in index.ts — so the runner can rotate tokens
 * even when no tasks are being claimed.
 */

import { runnerRefreshCredential } from './credential-refresh';

interface SeenEntry {
  purpose: 'claude_credential' | 'codex_credential';
  expiresAt: string | null;
}

const seenCredentials = new Map<string, SeenEntry>();

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export function updateSeenCredential(entry: {
  secretId: string;
  purpose: 'claude_credential' | 'codex_credential';
  expiresAt: string | null;
}): void {
  seenCredentials.set(entry.secretId, { purpose: entry.purpose, expiresAt: entry.expiresAt });
}

export function startCredentialRefreshSweep(): void {
  setInterval(async () => {
    const now = Date.now();
    for (const [secretId, entry] of seenCredentials) {
      const expMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
      if (expMs === null || expMs - now > TWO_HOURS_MS) continue;

      const result = await runnerRefreshCredential(secretId, entry.purpose);
      console.log(`[sweep] runnerRefreshCredential secretId=${secretId} purpose=${entry.purpose} → ${result}`);
    }
  }, SWEEP_INTERVAL_MS);
}
