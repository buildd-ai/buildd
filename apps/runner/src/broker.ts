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
import { existsSync, unlinkSync, writeFileSync } from 'fs';
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
  // Set when the control plane reports that a prior rotation was lost. Terminal:
  // the stored refresh token is dead, so re-asking only burns another
  // invalid_grant against the provider. Cleared only by a fresh lease acquire,
  // which re-bootstraps from whatever the DB holds after a reconnect.
  refreshDisabled?: boolean;
}

type CredentialEntry = {
  secretId: string;
  purpose: 'claude_credential' | 'codex_credential';
  expiresAt: string | null;
};

/**
 * Control-plane connection details for the broker. The runner resolves these in
 * `index.ts` (env var overriding config.json) and hands them to `start()`.
 */
export type BrokerConfig = {
  apiKey?: string;
  baseUrl?: string;
};

class CredentialBroker {
  private baseUrl: string;
  private apiKey: string;
  private readonly runnerId: string;
  readonly socketPath: string;

  private managed = new Map<string, ManagedCredential>(); // secretId → info
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private localServer: { stop(closeActiveConnections?: boolean): void } | null = null;
  private shuttingDown = false;
  // worker token files to update after a mid-session refresh:
  //   secretId → Map<workerId, credentialFilePath>
  private credentialFiles = new Map<string, Map<string, string>>();

  constructor() {
    // Env vars only — the module-level singleton is constructed at import time,
    // before config.json is loaded. The real values arrive via configure()/start().
    this.baseUrl = process.env.BUILDD_CLIENT_URL ?? 'https://buildd.dev';
    this.apiKey = process.env.BUILDD_API_KEY ?? '';
    this.runnerId = process.env.BUILDD_RUNNER_ID ?? hostname();
    this.socketPath = process.env.BUILDD_BROKER_SOCKET ?? '/tmp/buildd-broker.sock';
  }

  private get endpoint(): string {
    return `${this.baseUrl}/api/runner/credential-lease`;
  }

  private get refreshEndpoint(): string {
    return `${this.baseUrl}/api/runner/credential-refresh`;
  }

  /**
   * Adopt the runner's resolved control-plane config. Called from start(); the
   * constructor can only see the environment, and the runner's API key normally
   * lives in config.json rather than BUILDD_API_KEY.
   */
  configure(cfg: BrokerConfig): void {
    if (cfg.apiKey) this.apiKey = cfg.apiKey;
    if (cfg.baseUrl) this.baseUrl = cfg.baseUrl;
  }

  /** Start heartbeat and refresh loops; register SIGTERM/SIGINT handlers. */
  start(cfg?: BrokerConfig): void {
    if (cfg) this.configure(cfg);
    if (!this.apiKey) {
      // Every control-plane call would 401. The credential path is inert either
      // way; say so at startup instead of once per acquire, forever.
      console.warn(
        '[broker] No control-plane API key — credential leases and refreshes are DISABLED. ' +
        'Expected config.json apiKey or BUILDD_API_KEY.',
      );
    }
    this.heartbeatTimer = setInterval(() => { void this.heartbeatAll(); }, HEARTBEAT_INTERVAL_MS);
    this.refreshTimer = setInterval(() => { void this.refreshExpiring(); }, REFRESH_CHECK_INTERVAL_MS);
    this.startLocalServer();
    // Registering ANY listener for these signals replaces the default terminate
    // disposition, so the handler now owns exiting. The previous handlers just
    // called shutdown() and returned — and because the runner keeps Bun.serve
    // and its interval timers alive, the event loop never drained and the
    // process simply IGNORED SIGTERM. That silently broke every `kill` aimed at
    // a runner, and it is what made the update health probe unkillable: the
    // parent's `proc.kill()` was delivered, handled, and terminal for nothing,
    // leaking one full runner process per update attempt.
    //
    // Exit code 0: a signalled shutdown is not a failure.
    //
    // What exiting 0 *means* depends on which launcher started this process,
    // and the two that ship disagree — so weigh both before changing this:
    //
    //   - CLI launcher (`apps/runner/install.sh`): re-runs the entrypoint on
    //     exit 75 and only 75, so exiting 0 here STOPS the runner for good. A
    //     stray `kill`, `docker stop`, or supervisor stop now ends that runner
    //     until someone starts it again.
    //   - Coder-template launcher (`launch-buildd.sh`, generated by the
    //     workspace Terraform template — NOT in this repo, so grepping here
    //     will not find it): restarts on any exit code after a 5s sleep, so
    //     exiting 0 there is a restart, not a stop.
    //
    // Exiting is still the right semantic: ignoring SIGTERM does not keep the
    // process alive in the cases that matter — `docker stop` simply waits out
    // its grace period and SIGKILLs — it only makes the shutdown unclean and
    // the signal unobservable. But the CLI-launcher case is a real behaviour
    // change for runners whose launcher will not bring them back.
    const exitAfterShutdown = (signal: string) => {
      const failsafe = setTimeout(() => {
        console.error(`[broker] ${signal} shutdown did not complete within 10s — forcing exit`);
        process.exit(0);
      }, 10_000);
      this.shutdown()
        .catch((err) => console.error(`[broker] ${signal} shutdown failed: ${err?.message ?? err}`))
        .finally(() => { clearTimeout(failsafe); process.exit(0); });
    };
    process.on('SIGTERM', () => exitAfterShutdown('SIGTERM'));
    process.on('SIGINT', () => exitAfterShutdown('SIGINT'));
    console.log(`[broker] started runnerId=${this.runnerId} controlPlane=${this.baseUrl} auth=${this.apiKey ? 'ok' : 'MISSING'}`);
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
    if (!this.apiKey) return; // unauthenticated acquire is a guaranteed 401
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
        body: JSON.stringify({ credentialId: secretId, runnerId: this.runnerId, action: 'acquire' }),
      });
      if (!res.ok) {
        const hint = res.status === 401
          ? ' — control-plane rejected the runner API key (check config.json apiKey)'
          : '';
        console.warn(`[broker] acquire failed for ${secretId}: HTTP ${res.status}${hint}`);
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
      // A lost rotation is terminal — nothing this runner (or any other) can do
      // will refresh it, so stop asking. The lease is kept so another runner does
      // not pick the credential up and repeat the same dead attempt.
      if (cred.refreshDisabled) continue;
      const expMs = cred.expiresAt ? new Date(cred.expiresAt).getTime() : null;
      if (expMs !== null && expMs - now > TWO_HOURS_MS) continue;
      const result = await runnerRefreshCredential(secretId, cred.purpose, {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
      });
      console.log(`[broker] refresh ${secretId} purpose=${cred.purpose} → ${result}`);
      if (result === 'rotation_lost') {
        cred.refreshDisabled = true;
        console.warn(
          `[broker] refresh permanently disabled for ${secretId} (${cred.purpose}) — a prior ` +
          'rotation was lost and the credential must be reconnected before it can refresh again.',
        );
        continue;
      }
      if (result === 'refreshed') {
        // Optimistically extend so we don't re-refresh until the next claim response corrects it.
        cred.expiresAt = new Date(now + OPTIMISTIC_EXPIRY_AFTER_REFRESH_MS).toISOString();
        // Pull the freshly committed access token into in-memory cache so the next
        // broker token query returns the new token, and push it to active workers'
        // credential files to prevent mid-session 401s.
        await this.bootstrapCredential(secretId, cred.purpose);
        if (cred.accessToken) {
          this.updateCredentialFiles(secretId, cred.accessToken, cred.expiresAt);
        }
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

  /**
   * Register a worker's CLAUDE_CONFIG_DIR credential file so the broker can push
   * a fresh access_token into it after a mid-session proactive refresh. The worker
   * process reads this file on every Anthropic API call (the Claude Code SDK re-reads
   * the credentials file), so an in-place update extends the session beyond the
   * original token's TTL without restarting the subprocess.
   *
   * Call this immediately after materializeClaudeConfigDir returns.
   * Call deregisterCredentialFile in the finally block when the worker finishes.
   */
  registerCredentialFile(workerId: string, secretId: string, filePath: string): void {
    let workers = this.credentialFiles.get(secretId);
    if (!workers) {
      workers = new Map();
      this.credentialFiles.set(secretId, workers);
    }
    workers.set(workerId, filePath);
  }

  /** Remove a worker's credential file entry (call on worker completion/cleanup). */
  deregisterCredentialFile(workerId: string): void {
    for (const [secretId, workers] of this.credentialFiles) {
      if (workers.has(workerId)) {
        workers.delete(workerId);
        if (workers.size === 0) this.credentialFiles.delete(secretId);
        return;
      }
    }
  }

  /**
   * Write a fresh access_token to every registered credential file for this secretId.
   * File format matches materializeClaudeConfigDir: `{ type, access_token, expires_at? }`.
   */
  private updateCredentialFiles(secretId: string, accessToken: string, expiresAt: string | null): void {
    const workers = this.credentialFiles.get(secretId);
    if (!workers || workers.size === 0) return;
    const credentials: Record<string, unknown> = {
      type: 'oauth_token',
      access_token: accessToken,
      ...(expiresAt != null ? { expires_at: Math.floor(new Date(expiresAt).getTime() / 1000) } : {}),
    };
    const content = JSON.stringify(credentials);
    for (const [workerId, filePath] of workers) {
      try {
        // File was created by materializeClaudeConfigDir with mode 0600; writeFileSync
        // preserves existing permissions — no chmod needed here.
        writeFileSync(filePath, content);
        console.log(`[broker] Updated credential file for worker ${workerId} (secretId=${secretId})`);
      } catch (err) {
        console.warn(`[broker] Failed to update credential file for worker ${workerId}:`, err instanceof Error ? err.message : String(err));
      }
    }
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

/**
 * Fetch an access token from the broker's local Unix socket (env injection at spawn).
 *
 * Called by the harness once before spawning the worker subprocess. The returned
 * token is materialized into CLAUDE_CONFIG_DIR/.credentials.json and passed via
 * the CLAUDE_CONFIG_DIR env var — the worker process never calls this endpoint
 * directly (env injection, not socket-read approach).
 *
 * Returns null when:
 *  - broker socket is unavailable (runner started without broker)
 *  - credential not managed by this broker (403/404)
 *  - bootstrap still in progress (503)
 *  - network/timeout error
 *
 * On null, callers should fall back to the inline claudeAccessToken from the
 * claim response (Phase 1 path), which remains valid as a safety net.
 *
 * Timeout defaults to 2 s — fast enough not to block spawn, long enough for
 * the broker to respond even under moderate load.
 */
export async function fetchTokenFromBroker(
  secretId: string,
  socketPath: string,
  timeoutMs = 2_000,
): Promise<{ accessToken: string; expiresAt: string | null } | null> {
  if (!socketPath) return null;
  try {
    // Bun extends RequestInit with `unix` for Unix domain socket connections.
    const res = await fetch('http://localhost/token', {
      unix: socketPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential_id: secretId }),
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    if (!res.ok) return null;
    const data = await res.json() as { access_token?: string; expires_at?: string | null };
    if (!data.access_token) return null;
    return { accessToken: data.access_token, expiresAt: data.expires_at ?? null };
  } catch {
    return null;
  }
}
