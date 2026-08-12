/**
 * Credential broker daemon (Phase 2 of runner-anchored OAuth broker).
 *
 * Owns credential custody for this runner:
 *  - Acquires a per-credential Postgres lease before touching a credential.
 *  - Renews the lease via heartbeat every 60 s (well inside the 5-minute TTL).
 *  - Releases all leases on graceful shutdown (SIGTERM/SIGINT).
 *  - Proactively refreshes credentials expiring within 2 hours via the same
 *    lock → provider → commit flow as Phase 1's runnerRefreshCredential.
 *
 * Workers no longer call runnerRefreshCredential directly (Phase 1 in-harness
 * path removed). Instead they call notifyBrokerCredentials() so the broker knows
 * which credentials to manage and schedule refresh for.
 */

import { hostname } from 'os';
import { runnerRefreshCredential } from './credential-refresh';

const HEARTBEAT_INTERVAL_MS = 60 * 1_000;      // 60 s — well inside the 5-min lease TTL
const REFRESH_CHECK_INTERVAL_MS = 2 * 60 * 1_000; // 2 min
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
// After a successful refresh we don't have the new expiresAt immediately, so we
// optimistically set it to now + 8 h to avoid a tight re-refresh loop before the
// next claim response corrects it.
const OPTIMISTIC_EXPIRY_AFTER_REFRESH_MS = 8 * 60 * 60 * 1_000;

interface ManagedCredential {
  purpose: 'claude_credential' | 'codex_credential';
  expiresAt: string | null;
  leaseId: string;
  // Credential cache — populated on lease acquire via bootstrap pull; memory only, never disk.
  accessToken: string | null;
  refreshToken: string | null;
}

type CredentialEntry = {
  secretId: string;
  purpose: 'claude_credential' | 'codex_credential';
  expiresAt: string | null;
};

class CredentialBroker {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly runnerId: string;
  private readonly endpoint: string;
  private readonly refreshEndpoint: string;

  private managed = new Map<string, ManagedCredential>(); // secretId → info
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor() {
    this.baseUrl = process.env.BUILDD_CLIENT_URL ?? 'https://buildd.dev';
    this.apiKey = process.env.BUILDD_API_KEY ?? '';
    this.runnerId = process.env.BUILDD_RUNNER_ID ?? hostname();
    this.endpoint = `${this.baseUrl}/api/runner/credential-lease`;
    this.refreshEndpoint = `${this.baseUrl}/api/runner/credential-refresh`;
  }

  /** Start heartbeat and refresh loops; register SIGTERM/SIGINT handlers. */
  start(): void {
    this.heartbeatTimer = setInterval(() => { void this.heartbeatAll(); }, HEARTBEAT_INTERVAL_MS);
    this.refreshTimer = setInterval(() => { void this.refreshExpiring(); }, REFRESH_CHECK_INTERVAL_MS);
    process.on('SIGTERM', () => { void this.shutdown(); });
    process.on('SIGINT', () => { void this.shutdown(); });
    console.log(`[broker] started runnerId=${this.runnerId}`);
  }

  /**
   * Called from workers.ts when a claim response arrives with pendingCredentialRefreshes.
   * Fire-and-forget: we try to acquire leases asynchronously so the claim path is not blocked.
   */
  notifyCredentials(entries: CredentialEntry[]): void {
    for (const entry of entries) {
      if (this.managed.has(entry.secretId)) {
        // Update expiresAt so the refresh check stays current.
        this.managed.get(entry.secretId)!.expiresAt = entry.expiresAt;
      } else {
        void this.tryAcquireLease(entry.secretId, entry.purpose, entry.expiresAt);
      }
    }
  }

  /** Try to acquire the Postgres lease for a credential. No-op if another runner holds it. */
  private async tryAcquireLease(
    secretId: string,
    purpose: 'claude_credential' | 'codex_credential',
    expiresAt: string | null,
  ): Promise<void> {
    if (this.shuttingDown) return;
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
        body: JSON.stringify({ credentialId: secretId, runnerId: this.runnerId, action: 'acquire' }),
      });
      if (!res.ok) {
        console.warn(`[broker] acquire failed for ${secretId}: HTTP ${res.status}`);
        return;
      }
      const body = await res.json() as { acquired: boolean; leaseId?: string };
      if (!body.acquired || !body.leaseId) {
        console.log(`[broker] lease held by another runner for ${secretId}`);
        return;
      }
      this.managed.set(secretId, { purpose, expiresAt, leaseId: body.leaseId, accessToken: null, refreshToken: null });
      console.log(`[broker] acquired lease ${body.leaseId} for ${secretId} purpose=${purpose}`);
      await this.bootstrapCredential(secretId, purpose);
    } catch (err) {
      console.warn(`[broker] network error acquiring lease for ${secretId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Pull the current credential from the control plane after acquiring a lease.
   * Stores accessToken and refreshToken in the in-memory managed map only — nothing is
   * written to disk. On broker restart the map is empty and bootstrap re-runs after
   * the lease is re-acquired, so the runner never trusts stale on-disk state.
   */
  private async bootstrapCredential(
    secretId: string,
    purpose: 'claude_credential' | 'codex_credential',
  ): Promise<void> {
    try {
      const res = await fetch(this.refreshEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
        body: JSON.stringify({ secretId, purpose, action: 'bootstrap', runnerId: this.runnerId }),
      });
      if (!res.ok) {
        console.warn(`[broker] bootstrap failed for ${secretId}: HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as {
        accessToken?: string | null;
        refreshToken?: string | null;
        expiresAt?: string | null;
      };
      const entry = this.managed.get(secretId);
      if (!entry) return; // race: lease was released during async bootstrap
      entry.accessToken = data.accessToken ?? null;
      entry.refreshToken = data.refreshToken ?? null;
      if (data.expiresAt) entry.expiresAt = data.expiresAt;
      console.log(`[broker] bootstrapped ${secretId} purpose=${purpose} expiresAt=${data.expiresAt ?? 'null'}`);
    } catch (err) {
      console.warn(`[broker] network error bootstrapping ${secretId}:`, err instanceof Error ? err.message : String(err));
    }
  }

  /** Heartbeat all held leases. Drops leases that the control plane reports as stolen. */
  private async heartbeatAll(): Promise<void> {
    if (this.shuttingDown || this.managed.size === 0) return;
    for (const [secretId] of this.managed) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.authHeader() },
          body: JSON.stringify({ credentialId: secretId, runnerId: this.runnerId, action: 'heartbeat' }),
        });
        if (res.status === 404) {
          // Lease was stolen by a runner whose previous lease TTL lapsed — drop it.
          console.warn(`[broker] lease stolen for ${secretId} — removing from managed set`);
          this.managed.delete(secretId);
        } else if (!res.ok) {
          console.warn(`[broker] heartbeat failed for ${secretId}: HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(`[broker] network error heartbeating ${secretId}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Check for credentials expiring within 2 h and refresh them. */
  private async refreshExpiring(): Promise<void> {
    if (this.shuttingDown) return;
    const now = Date.now();
    for (const [secretId, cred] of this.managed) {
      const expMs = cred.expiresAt ? new Date(cred.expiresAt).getTime() : null;
      if (expMs !== null && expMs - now > TWO_HOURS_MS) continue;
      const result = await runnerRefreshCredential(secretId, cred.purpose);
      console.log(`[broker] refresh ${secretId} purpose=${cred.purpose} → ${result}`);
      if (result === 'refreshed') {
        // Optimistically extend so we don't re-refresh until the next claim response corrects it.
        cred.expiresAt = new Date(now + OPTIMISTIC_EXPIRY_AFTER_REFRESH_MS).toISOString();
      }
    }
  }

  /** Release all leases and stop loops. Called on SIGTERM/SIGINT. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    console.log(`[broker] shutting down, releasing ${this.managed.size} lease(s)`);
    await Promise.all(
      Array.from(this.managed.keys()).map(async (secretId) => {
        try {
          await fetch(this.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.authHeader() },
            body: JSON.stringify({ credentialId: secretId, runnerId: this.runnerId, action: 'release' }),
          });
        } catch {
          // Best-effort — TTL ensures the lease expires naturally within 5 minutes.
        }
      }),
    );
    this.managed.clear();
    console.log('[broker] shutdown complete');
  }

  private authHeader(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }
}

// Export the class for testing.
export { CredentialBroker };

// Module-level singleton — started by index.ts, used by workers.ts.
export const credentialBroker = new CredentialBroker();

/** Called from workers.ts after each claim response that includes pendingCredentialRefreshes. */
export function notifyBrokerCredentials(entries: CredentialEntry[]): void {
  credentialBroker.notifyCredentials(entries);
}
