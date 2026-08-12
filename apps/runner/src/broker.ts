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
import { existsSync, unlinkSync } from 'fs';
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
  readonly socketPath: string;

  private managed = new Map<string, ManagedCredential>(); // secretId → info
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private localServer: { stop(closeActiveConnections?: boolean): void } | null = null;
  private shuttingDown = false;

  constructor() {
    this.baseUrl = process.env.BUILDD_CLIENT_URL ?? 'https://buildd.dev';
    this.apiKey = process.env.BUILDD_API_KEY ?? '';
    this.runnerId = process.env.BUILDD_RUNNER_ID ?? hostname();
    this.endpoint = `${this.baseUrl}/api/runner/credential-lease`;
    this.refreshEndpoint = `${this.baseUrl}/api/runner/credential-refresh`;
    this.socketPath = process.env.BUILDD_BROKER_SOCKET ?? '/tmp/buildd-broker.sock';
  }

  /** Start heartbeat and refresh loops; register SIGTERM/SIGINT handlers. */
  start(): void {
    this.heartbeatTimer = setInterval(() => { void this.heartbeatAll(); }, HEARTBEAT_INTERVAL_MS);
    this.refreshTimer = setInterval(() => { void this.refreshExpiring(); }, REFRESH_CHECK_INTERVAL_MS);
    this.startLocalServer();
    process.on('SIGTERM', () => { void this.shutdown(); });
    process.on('SIGINT', () => { void this.shutdown(); });
    console.log(`[broker] started runnerId=${this.runnerId}`);
  }

  /**
   * Bind a local HTTP server to a Unix socket so co-located workers can request
   * access tokens without ever seeing a refresh token.
   *
   * Unix socket over loopback TCP: file-system permissions (mode 0600) enforce
   * that only the runner's OS user can reach the endpoint — no second auth layer
   * is needed because the socket itself IS the trust boundary.
   */
  private startLocalServer(): void {
    // Remove a stale socket left by a previous crash before binding.
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }
    this.localServer = Bun.serve({
      unix: this.socketPath,
      fetch: (req) => this.handleLocalRequest(req),
    });
    // Restrict access to the current OS user (mode 0600) so that only
    // processes running as the same user can connect.  We use spawnSync
    // rather than fs.chmodSync to avoid conflicts with test fs mocks.
    const chmod = Bun.spawnSync(['chmod', '0600', this.socketPath]);
    if (chmod.exitCode !== 0) {
      console.warn(`[broker] chmod 0600 failed for ${this.socketPath}`);
    }
    console.log(`[broker] local token server listening on unix:${this.socketPath}`);
  }

  /**
   * Handle a single request from the local Unix socket server.
   *
   * POST /token  { credential_id: string }
   *   200 → { access_token: string, expires_at: string | null }
   *   400 → missing or invalid credential_id
   *   404 → credential not managed by this broker
   *   405 → wrong HTTP method
   *   503 → credential managed but not yet bootstrapped (tokens null)
   */
  private async handleLocalRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname !== '/token') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (req.method !== 'POST') {
      return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    }

    let credentialId: string;
    try {
      const body = await req.json() as { credential_id?: unknown };
      if (typeof body.credential_id !== 'string' || !body.credential_id) {
        return Response.json({ error: 'missing credential_id' }, { status: 400 });
      }
      credentialId = body.credential_id;
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }

    const cred = this.managed.get(credentialId);
    if (!cred) {
      return Response.json({ error: 'not_managed' }, { status: 404 });
    }
    if (!cred.accessToken) {
      return Response.json({ error: 'not_ready' }, { status: 503 });
    }
    return Response.json({ access_token: cred.accessToken, expires_at: cred.expiresAt });
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

  /** Release all leases, stop loops, and close the local socket server. Called on SIGTERM/SIGINT. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    // Stop the local token server and remove the socket file.
    if (this.localServer !== null) {
      this.localServer.stop(true);
      this.localServer = null;
    }
    try { unlinkSync(this.socketPath); } catch {}
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

/**
 * The Unix socket path the local token server listens on.
 * Workers use this to request access tokens from the broker.
 * Reads BUILDD_BROKER_SOCKET env var; falls back to '/tmp/buildd-broker.sock'.
 */
export function getBrokerSocketPath(): string {
  return credentialBroker.socketPath;
}
