/**
 * Model certification probe (packages/core/model-certification.ts).
 *
 * On an idle heartbeat tick, at most every PROBE_INTERVAL_MS, ask the server
 * whether a newly discovered model needs certifying at this runner's Claude
 * Code version. If one does, launch it once with a one-turn, no-tools prompt
 * and report whether it ran, or the provider's exact error (whose "version
 * A.B.C or newer is required" names the model's CLI floor).
 *
 * The server only hands leases to accounts it trusts to certify for everyone
 * (BUILDD_MODEL_PROBE_ACCOUNT_IDS); every other runner gets `{ model: null }`
 * and this costs one small request per interval. Opt out with BUILDD_MODEL_PROBE=0.
 * Never throws, never holds a worker slot.
 */
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeBinaryPath } from './sdk-binary-path';

export const PROBE_INTERVAL_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 120 * 1000;
const PROBE_PROMPT = 'Reply with the single word OK.';

export interface ModelProbeApi {
  lease(cliVersion: string): Promise<{ model: string | null; leaseId?: string }>;
  report(r: { model: string; leaseId: string; cliVersion: string; ok: boolean; error?: string | null }): Promise<void>;
}

export type ProbeFn = (model: string) => Promise<{ ok: boolean; error?: string | null }>;

export class ModelProbePoller {
  private running = false;
  private lastPollAt = 0;

  constructor(
    private readonly deps: {
      api: ModelProbeApi;
      probe: ProbeFn;
      cliVersion: () => string | undefined;
      enabled?: boolean;
      intervalMs?: number;
      now?: () => number;
    },
  ) {}

  /** One probe at most per interval, one at a time. Resolves true when a probe ran. */
  async poll(): Promise<boolean> {
    if (this.deps.enabled === false || this.running) return false;
    const now = (this.deps.now ?? Date.now)();
    if (now - this.lastPollAt < (this.deps.intervalMs ?? PROBE_INTERVAL_MS)) return false;
    const cliVersion = this.deps.cliVersion();
    if (!cliVersion) return false;
    this.running = true;
    this.lastPollAt = now;
    try {
      const lease = await this.deps.api.lease(cliVersion);
      if (!lease.model || !lease.leaseId) return false;
      console.log(`[model-probe] certifying ${lease.model} on Claude Code ${cliVersion}`);
      const result = await this.deps.probe(lease.model).catch((e: unknown) => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
      await this.deps.api.report({
        model: lease.model,
        leaseId: lease.leaseId,
        cliVersion,
        ok: result.ok,
        error: result.ok ? null : (result.error ?? 'probe failed'),
      });
      console.log(`[model-probe] ${lease.model}: ${result.ok ? 'launched OK' : `failed: ${result.error}`}`);
      return true;
    } catch (err) {
      console.warn('[model-probe] poll failed:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      this.running = false;
    }
  }
}

/** Launch `model` once through the Agent SDK, exactly as a worker would, with no tools. */
export const sdkProbe: ProbeFn = async (model) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  const pathToClaudeCodeExecutable = resolveClaudeBinaryPath();
  try {
    const q = query({
      prompt: PROBE_PROMPT,
      options: {
        model,
        maxTurns: 1,
        cwd: os.tmpdir(),
        allowedTools: [],
        settingSources: [],
        abortController: abort,
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      } as Parameters<typeof query>[0]['options'],
    });
    let error: string | null = null;
    let sawResult = false;
    for await (const msg of q) {
      const m = msg as any;
      if (m.type === 'assistant' && m.error) error = String(m.error);
      if (m.type === 'result') {
        sawResult = true;
        if (m.is_error || m.subtype !== 'success') {
          error = [m.result, ...(Array.isArray(m.errors) ? m.errors : [])].filter(Boolean).join(' ') || error || m.subtype;
        }
      }
    }
    if (!sawResult) return { ok: false, error: error ?? 'no result from Claude Code' };
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
};

export function createModelProbeHttpApi(cfg: { serverUrl: string; apiKey: string }): ModelProbeApi {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${cfg.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.json();
  };
  return {
    lease: (cliVersion) => post('/api/runner/model-probe', { claudeCliVersion: cliVersion }),
    report: async (r) => { await post('/api/runner/model-probe/report', r); },
  };
}
