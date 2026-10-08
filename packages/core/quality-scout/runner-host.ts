/**
 * Hosting one claimed Quality Scout run on a machine with a clone of the repo:
 * the runner's Scout host (apps/runner/src/scout-host.ts) and the dogfood
 * script's `--server` mode share this. Design: artifact
 * `quality-scout-runner-host` §6.
 *
 * Per run:
 *  1. The SHA must be a full 40-hex commit; anything else is released.
 *  2. The clone fetches the SHA (released when it cannot, never run against
 *     another commit), then a throwaway `git worktree add --detach` of exactly
 *     that SHA. No branch is created, so nothing can be pushed by accident.
 *  3. Fixture setup (the declared `qualityScout.fixtureSetup`, else the
 *     lockfile's frozen install) runs once. If it fails, every probe is
 *     reported `inconclusive: fixture_setup_failed`, never `fail`.
 *  4. Each probe runs through `runScoutProbe` against the server's frozen
 *     profile, its command in an allowlisted environment (`buildScoutProbeEnv`:
 *     no runner, GitHub, Claude or Codex credential, no git credential helper)
 *     and, when the host supplies `wrap`, inside its sandbox.
 *  5. A surface probe captures through `visual-qa.yml` with the run-scoped
 *     token the claim carried (`claimed.capture`). The token lives in this
 *     function's closure only: not in `env`, not on disk; it is dropped when
 *     the lease ends and revoked when the run does. No grant, no capture
 *     port: the probe is `unsupported`. At most `budget.maxCaptureProbes`.
 *  6. Results go back through the run API, one probe per call.
 *  7. The worktree and its temp home are removed, success or not.
 *
 * Nothing here writes a finding, files a task or touches a PR: the server
 * finalizes the run.
 */

// Namespace import: runner unit tests replace 'fs' with partial mocks, and a
// named import of a function a mock lacks fails at module link time.
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import type {
  ScoutHostedProbeResult,
  ScoutProbeResultsResponse,
  ScoutRunClaimRequest,
  ScoutRunClaimResponse,
  ScoutRunEvidenceUploadResponse,
  ScoutRunReleaseResponse,
} from '@buildd/shared';
import type { VerificationEvidenceRef } from '../verification-check';
import { checkCheckoutFetchable, type CheckoutCheck } from '../knowledge-store/full-ingest';
import { createSecretRedactor } from '../redaction';
import type { ScoutCapabilityProfile } from '../scout-capabilities';
import { planScoutProbe, runScoutProbe, type ScoutCommandOutput, type ScoutProbePorts } from './executors';
import { exec, gitHead, gitStatus, localCommandPort } from './local-host';
import { DEFAULT_SCOUT_MAX_CAPTURE_PROBES, type ScoutProbeRecord, type ScoutRun } from './types';
import {
  createVisualQaCapturePort,
  limitScoutCapturePort,
  revokeInstallationToken,
  tokenVisualQaActions,
  type ScoutCaptureCredential,
  type ScoutCapturePort,
  type VisualQaCapturePortOptions,
} from './visual-capture';

export type ScoutClaimed = Extract<ScoutRunClaimResponse, { run: object }>;

// ── Probe environment ───────────────────────────────────────────────────────

/**
 * The only variables of the host's env a probe command sees. Locale, timezone
 * and TLS trust paths: nothing that authenticates anything.
 */
export const SCOUT_PROBE_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO',
];

/** Egress proxies pass only when they carry no userinfo (a proxy URL can embed a password). */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/**
 * Names that are never set in a probe env, whatever produced them. The
 * allowlist already excludes all of these; this is the second lock.
 */
export const SCOUT_PROBE_ENV_DENY = /^(BUILDD_|GITHUB_|GH_|ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|DISPATCH_|TENANT_|DATABASE_|AWS_|SSH_)|(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i;

export interface ScoutProbeEnvOptions {
  /** A fresh, empty directory: the probe's HOME. */
  home: string;
  /** The probe's TMPDIR. */
  tmp: string;
}

/**
 * The whole environment of a probe subprocess: built from an allowlist, never
 * from the host's env minus some keys. `HOME` is a fresh temp dir (no
 * `~/.buildd`, `~/.claude`, `~/.config/gh`, `~/.gitconfig`), `CI=1`, and git
 * is told to use no credential helper at any config level and never prompt.
 */
export function buildScoutProbeEnv(source: Record<string, string | undefined>, opts: ScoutProbeEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SCOUT_PROBE_ENV_PASSTHROUGH) {
    const v = source[k];
    if (v !== undefined) env[k] = v;
  }
  for (const k of PROXY_VARS) {
    const v = source[k];
    if (v !== undefined && !/:\/\/[^/]*@/.test(v)) env[k] = v;
  }
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin';
  Object.assign(env, {
    HOME: opts.home,
    TMPDIR: opts.tmp,
    TMP: opts.tmp,
    TEMP: opts.tmp,
    CI: '1',
    TERM: 'dumb',
    // git: no prompt, no system/global config, and an empty credential.helper
    // at command-line level, which beats a repo-local helper too.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  });
  for (const k of Object.keys(env)) if (SCOUT_PROBE_ENV_DENY.test(k)) delete env[k];
  return env;
}

// ── Fixture setup ───────────────────────────────────────────────────────────

const LOCKFILE_INSTALLS: ReadonlyArray<[string, string]> = [
  ['bun.lock', 'bun install --frozen-lockfile'],
  ['bun.lockb', 'bun install --frozen-lockfile'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['uv.lock', 'uv sync --frozen'],
];

/**
 * The run's one setup command: the owner's `qualityScout.fixtureSetup`, else
 * the frozen install for the lockfile at the worktree root, else none.
 */
export function scoutFixtureCommand(profile: ScoutCapabilityProfile, dir: string, exists: (p: string) => boolean = (p) => fs.existsSync(p)): string | null {
  const declared = profile.capabilities.find((c) => c.kind === 'fixture-setup' && c.status === 'available' && c.value);
  if (declared?.value) return declared.value;
  for (const [file, cmd] of LOCKFILE_INSTALLS) if (exists(join(dir, file))) return cmd;
  return null;
}

export const SCOUT_FIXTURE_TIMEOUT_MS = 10 * 60_000;
export const SCOUT_FIXTURE_FAILED = 'fixture_setup_failed';
/** The run API's bounds on `signatureParts` (more is refused 400 `bad_signature_parts`). */
export const MAX_SCOUT_SIGNATURE_PARTS = 20;
const MAX_SIGNATURE_PART_CHARS = 120;
export const DEFAULT_RUNNER_PROBE_ATTEMPTS = 2;

// ── Run API client ──────────────────────────────────────────────────────────

export type ScoutPostResult =
  | { ok: true; body: ScoutProbeResultsResponse }
  | { ok: false; status: number; code: string | null };

export interface ScoutHostApi {
  claim(req: ScoutRunClaimRequest): Promise<ScoutRunClaimResponse>;
  postResults(runId: string, leaseId: string, results: ScoutHostedProbeResult[]): Promise<ScoutPostResult>;
  release(runId: string, leaseId: string, reason: string): Promise<boolean>;
  /**
   * Store one command log as a run evidence object: ask the server for a
   * presigned PUT under the run's lease, PUT the bytes, confirm. The evidence
   * id once stored, else null. The runner never holds a storage credential.
   */
  uploadEvidence?(runId: string, leaseId: string, upload: { kind: 'command_output'; seq: number; body: Uint8Array }): Promise<string | null>;
}

export function createScoutHostHttpApi(opts: { serverUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): ScoutHostApi {
  const base = opts.serverUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const post = (path: string, body: unknown) =>
    doFetch(`${base}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
    });
  const code = async (res: Response) => {
    try {
      const j = (await res.json()) as { code?: unknown };
      return typeof j?.code === 'string' ? j.code : null;
    } catch {
      return null;
    }
  };
  return {
    async claim(req) {
      const res = await post('/api/quality-scout/runs/claim', req);
      if (!res.ok) throw new Error(`scout claim failed: HTTP ${res.status}`);
      return (await res.json()) as ScoutRunClaimResponse;
    },
    async postResults(runId, leaseId, results) {
      const res = await post(`/api/quality-scout/runs/${encodeURIComponent(runId)}/probes`, { leaseId, results });
      if (!res.ok) return { ok: false, status: res.status, code: await code(res) };
      return { ok: true, body: (await res.json()) as ScoutProbeResultsResponse };
    },
    async release(runId, leaseId, reason) {
      const res = await post(`/api/quality-scout/runs/${encodeURIComponent(runId)}/release`, { leaseId, reason });
      if (!res.ok) return false;
      return ((await res.json()) as ScoutRunReleaseResponse).released === true;
    },
    async uploadEvidence(runId, leaseId, { kind, seq, body }) {
      const run = encodeURIComponent(runId);
      const asked = await post(`/api/quality-scout/runs/${run}/evidence`, { leaseId, kind, seq, sizeBytes: body.byteLength });
      if (!asked.ok) return null;
      const signed = (await asked.json()) as ScoutRunEvidenceUploadResponse;
      if (typeof signed?.uploadUrl !== 'string' || typeof signed.evidenceId !== 'string') return null;
      // To the storage host, not buildd: no Authorization header, only the signed length.
      const put = await doFetch(signed.uploadUrl, {
        method: 'PUT',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(body.byteLength) },
        body: body as unknown as BodyInit,
      });
      if (!put.ok) return null;
      const confirmed = await post(`/api/quality-scout/runs/${run}/evidence/${encodeURIComponent(signed.evidenceId)}/confirm`, { leaseId });
      if (!confirmed.ok) return null;
      const state = ((await confirmed.json()) as { uploadState?: unknown }).uploadState;
      return state === 'stored' ? signed.evidenceId : null;
    },
  };
}

// ── Command logs as run evidence ────────────────────────────────────────────

/** A command log is uploaded at most this big; the tail is kept, since a failure is reported at the end. */
export const MAX_SCOUT_EVIDENCE_TEXT_BYTES = 1024 * 1024;

/**
 * Replace each `file:` ref a probe produced (a log `localCommandPort` wrote
 * under `evidenceDir`) with `evidence:<id>`: the log, redacted with the
 * host's own secret values and gzipped, uploaded through the run API. A path
 * outside `evidenceDir`, a host API without uploads, or any failure drops the
 * ref (the server would drop a `file:` ref anyway); the result's bounded
 * `observed` excerpt still stands. Other refs pass through. Never throws.
 */
export async function uploadScoutCommandLogs(
  refs: readonly VerificationEvidenceRef[],
  opts: {
    api: ScoutHostApi;
    runId: string;
    leaseId: string;
    evidenceDir: string;
    redact: (text: string) => string;
    nextSeq: () => number;
    log?: (msg: string) => void;
  },
): Promise<VerificationEvidenceRef[]> {
  const out: VerificationEvidenceRef[] = [];
  const root = resolve(opts.evidenceDir) + sep;
  for (const ref of refs) {
    if (!ref.ref.startsWith('file:')) { out.push(ref); continue; }
    const path = resolve(ref.ref.slice('file:'.length));
    if (!path.startsWith(root) || !opts.api.uploadEvidence) continue;
    try {
      let raw = fs.readFileSync(path);
      if (raw.byteLength > MAX_SCOUT_EVIDENCE_TEXT_BYTES) raw = raw.subarray(raw.byteLength - MAX_SCOUT_EVIDENCE_TEXT_BYTES);
      const body = gzipSync(Buffer.from(opts.redact(raw.toString('utf8')), 'utf8'));
      const id = await opts.api.uploadEvidence(opts.runId, opts.leaseId, { kind: 'command_output', seq: opts.nextSeq(), body });
      if (id) out.push({ kind: ref.kind, ref: `evidence:${id}` });
      else opts.log?.(`[scout-host] run ${opts.runId.slice(0, 8)}: command log not stored; the probe keeps its excerpt`);
    } catch (err) {
      opts.log?.(`[scout-host] run ${opts.runId.slice(0, 8)}: command log upload failed (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`);
    }
  }
  return out;
}

// ── Hosting a claimed run ───────────────────────────────────────────────────

export interface HostScoutRunOptions {
  claimed: ScoutClaimed;
  /** The clone to check the SHA out of. */
  repoPath: string;
  api: ScoutHostApi;
  /** Builds the sandbox argv around a probe command, for this run's worktree and home. Absent: unsandboxed. */
  wrapFor?: (ctx: { worktree: string; home: string; repoPath: string }) => (argv: string[]) => string[];
  /** The host's env, filtered through `buildScoutProbeEnv`. Default process.env. */
  sourceEnv?: Record<string, string | undefined>;
  /** Values never to echo back in a probe excerpt (the host's own secrets). */
  secretValues?: string[];
  /** Pre-flight on the clone. Default: has the SHA or can fetch it. */
  checkCheckout?: (repoPath: string, sha: string) => Promise<CheckoutCheck>;
  /** Parent of the throwaway dir. Default os.tmpdir(). */
  tmpRoot?: string;
  attempts?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Capture port tuning and the GitHub fetch (tests). */
  capture?: Pick<VisualQaCapturePortOptions, 'pollMs' | 'sleep' | 'timeoutMs'> & { fetchImpl?: typeof fetch };
}

/** Is this claimed probe a surface (capture) probe under the frozen profile? */
function isCaptureProbe(probe: ScoutProbeRecord, profile: ScoutCapabilityProfile): boolean {
  const plan = planScoutProbe(probe, profile);
  return plan.status === 'runnable' && plan.action.adapter === 'surface';
}

export type HostScoutRunOutcome =
  | { status: 'released'; reason: string; unfetchable: boolean }
  | { status: 'reported'; posted: string[]; fixtureFailed: boolean; finalized: boolean; stopped: string | null };

const FULL_SHA = /^[0-9a-f]{40}$/;

export async function hostClaimedScoutRun(opts: HostScoutRunOptions): Promise<HostScoutRunOutcome> {
  const { claimed, api, repoPath } = opts;
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? (() => new Date());
  const { run, lease } = claimed;
  const sha = run.candidate.sha;
  // The capture grant lives in this closure and nowhere else. Every way out
  // of this function drops and revokes it (GitHub mints for an hour; the run
  // is done sooner).
  let credential: ScoutCaptureCredential | null = claimed.capture
    ? {
      token: claimed.capture.token,
      expiresAt: new Date(Math.min(Date.parse(claimed.capture.expiresAt), Date.parse(lease.expiresAt))).toISOString(),
      repository: claimed.capture.repository,
    }
    : null;
  const revoke = async () => {
    const held = credential;
    credential = null;
    if (held) await revokeInstallationToken(held.token, opts.capture?.fetchImpl);
  };
  const release = async (reason: string, unfetchable: boolean): Promise<HostScoutRunOutcome> => {
    await revoke();
    log(`[scout-host] releasing run ${run.id.slice(0, 8)}: ${reason}`);
    try { await api.release(run.id, lease.leaseId, reason); } catch { /* the lease lapses on its own */ }
    return { status: 'released', reason, unfetchable };
  };

  if (typeof sha !== 'string' || !FULL_SHA.test(sha)) return release('candidate is not a full commit SHA', false);
  const check = await (opts.checkCheckout ?? checkCheckoutFetchable)(repoPath, sha);
  if (!check.ok) return release(`checkout cannot serve ${sha.slice(0, 12)}: ${check.reason}`, true);

  const parent = opts.tmpRoot ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(join(parent, `scout-${run.id.slice(0, 8)}-`));
  const worktree = join(root, 'wt');
  const home = join(root, 'home');
  const tmp = join(home, 'tmp');
  const evidenceDir = join(root, 'evidence');
  let added = false;
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const add = await exec('git', ['-C', repoPath, 'worktree', 'add', '--detach', worktree, sha], { cwd: repoPath, timeoutMs: 120_000 });
    if (add.code !== 0) return await release(`git worktree add failed: ${add.stderr.trim().split('\n')[0]?.slice(0, 160) ?? ''}`, false);
    added = true;
    const head = await gitHead(worktree).catch(() => null);
    const dirty = await gitStatus(worktree).catch(() => null);
    if (head !== sha || dirty === null || dirty.trim() !== '') {
      return await release(head !== sha ? `worktree is at ${head?.slice(0, 12) ?? 'unknown'}, not ${sha.slice(0, 12)}` : 'fresh worktree is not clean', false);
    }

    const env = buildScoutProbeEnv(opts.sourceEnv ?? process.env, { home, tmp });
    const wrap = opts.wrapFor?.({ worktree, home, repoPath });
    const profile = claimed.profile as unknown as ScoutCapabilityProfile;
    const scoutRun = run as unknown as ScoutRun;
    const redactValues = [...(opts.secretValues ?? [])];
    const deadline = Math.min(Date.parse(lease.expiresAt), now().getTime() + lease.runnerMaxDurationMs);

    const probes = claimed.probes as unknown as ScoutProbeRecord[];
    const captureIds = new Set(probes.filter((p) => isCaptureProbe(p, profile)).map((p) => p.candidateId));

    // A grant with no surface probe to use it on is revoked now.
    if (captureIds.size === 0) await revoke();
    let capturePort: ScoutCapturePort | null = null;
    if (credential) {
      redactValues.push(credential.token);
      const { fetchImpl, ...portOpts } = opts.capture ?? {};
      capturePort = limitScoutCapturePort(
        createVisualQaCapturePort(
          tokenVisualQaActions({ repoFullName: credential.repository, credential: () => credential, fetchImpl, now: () => now().getTime() }),
          { ...portOpts, now: () => now().getTime(), deadlineMs: deadline },
        ),
        run.budget.maxCaptureProbes ?? DEFAULT_SCOUT_MAX_CAPTURE_PROBES,
      );
    } else if (captureIds.size > 0) {
      log(`[scout-host] run ${run.id.slice(0, 8)}: no capture credential (${claimed.captureUnavailable ?? 'none issued'}); surface probes run without a capture port`);
    }
    const redact = createSecretRedactor(redactValues.filter((v) => v && v.length >= 8));

    // Fixture setup, once, and only when a command probe needs the checkout's dependencies.
    let fixtureFailure: string | null = null;
    const fixture = probes.some((p) => !captureIds.has(p.candidateId)) ? scoutFixtureCommand(profile, worktree) : null;
    if (fixture) {
      const setup = localCommandPort({ dir: worktree, evidenceDir, env, wrap });
      const out = await setup.port.run({ command: fixture, timeoutMs: Math.max(1_000, Math.min(SCOUT_FIXTURE_TIMEOUT_MS, deadline - now().getTime())), ref: run.candidate.ref, sha });
      const changed = setup.records[0]?.treeChanges ?? [];
      if (out.exitCode !== 0 || out.timedOut) {
        fixtureFailure = `Fixture setup \`${fixture}\` ${out.timedOut ? 'timed out' : `exited ${out.exitCode ?? 'without a code'}`}.`;
      } else if (changed.length > 0) {
        fixtureFailure = `Fixture setup \`${fixture}\` changed tracked files (${changed.length}).`;
      }
      if (fixtureFailure) log(`[scout-host] run ${run.id.slice(0, 8)}: ${fixtureFailure}`);
    }

    const ports: ScoutProbePorts = {
      command: fixtureFailure
        ? { run: async (): Promise<ScoutCommandOutput> => ({ exitCode: null, timedOut: false, stderrTail: SCOUT_FIXTURE_FAILED }) }
        : localCommandPort({ dir: worktree, evidenceDir, env, wrap }).port,
      ...(capturePort ? { capture: capturePort } : {}),
    };

    const posted: string[] = [];
    let evidenceSeq = 0;
    let finalized = false;
    let stopped: string | null = null;
    for (const probe of probes) {
      if (now().getTime() >= deadline) { stopped = 'deadline'; break; }
      const isCapture = captureIds.has(probe.candidateId);
      // A fixture failure is about the checkout; a capture runs on GitHub's runner, not here.
      const fixtureHit = fixtureFailure !== null && !isCapture;
      const exec = await runScoutProbe(scoutRun, probe, profile, ports, {
        // One capture attempt: each is a workflow run per viewport.
        attempts: fixtureHit || isCapture ? 1 : opts.attempts ?? DEFAULT_RUNNER_PROBE_ATTEMPTS,
        redact,
        now,
      });
      // The core result as-is (its `signatureParts` are what the server derives the signature from),
      // except that a failed fixture setup is reported as such, never as the probe's verdict.
      const result = exec.probe.result!;
      const entry: ScoutHostedProbeResult = {
        candidateId: probe.candidateId,
        result: fixtureHit
          ? {
            ...result,
            verdict: result.verdict === 'unsupported' ? 'unsupported' : 'inconclusive',
            severity: null,
            observed: fixtureFailure,
            reason: SCOUT_FIXTURE_FAILED,
          }
          : { ...result },
        reproducibility: exec.reproducibility,
      };
      // Command logs on this host's disk become run evidence objects the server can read back.
      entry.result.evidenceRefs = await uploadScoutCommandLogs(entry.result.evidenceRefs ?? [], {
        api, runId: run.id, leaseId: lease.leaseId, evidenceDir, redact, nextSeq: () => evidenceSeq++, log,
      });
      // The run API's bound; a command judge's parts are far inside it.
      if (entry.result.signatureParts) {
        entry.result.signatureParts = entry.result.signatureParts.slice(0, MAX_SCOUT_SIGNATURE_PARTS).map((p) => p.slice(0, MAX_SIGNATURE_PART_CHARS));
      }
      const res = await api.postResults(run.id, lease.leaseId, [entry]);
      if (!res.ok) {
        stopped = `post_refused:${res.status}:${res.code ?? 'unknown'}`;
        log(`[scout-host] run ${run.id.slice(0, 8)}: result for ${probe.candidateId} refused (${res.status} ${res.code ?? ''})`);
        // A lost or expired lease means the run is no longer ours.
        if (res.status === 409) break;
        continue;
      }
      posted.push(probe.candidateId);
      if (res.body.finalized) finalized = true;
    }
    return { status: 'reported', posted, fixtureFailed: fixtureFailure !== null, finalized, stopped };
  } finally {
    await revoke().catch(() => false);
    if (added) {
      await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktree], { cwd: repoPath, timeoutMs: 60_000 }).catch(() => null);
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    if (added) await exec('git', ['-C', repoPath, 'worktree', 'prune'], { cwd: repoPath, timeoutMs: 60_000 }).catch(() => null);
  }
}
