/**
 * Quality Scout runner host: the server half of the runner-facing run API
 * (/api/quality-scout/runs/claim, [id]/probes, [id]/release). Design: artifact
 * `quality-scout-runner-host` §4.
 *
 * A run parked `awaiting_host` is the queue. A runner of the run's team claims
 * it with an atomic lease, executes only the runner-assigned probes against
 * the frozen profile the server planned with, and reports substrate results.
 * When the last runner probe lands, the server finalizes the run with its own
 * stores, so findings and the follow-up policy never leave the server and a
 * `shadow` run stays write-free.
 *
 * Authority, in order: the caller's API key resolves to a team; a run is
 * visible only when its workspace is in that team AND in the key's claimable
 * workspaces; a result or release is accepted only from the key and lease id
 * that currently hold the run's unexpired lease. The lease holder stored on
 * the row is `<accountId>:<leaseId>`, so a second claim after a lapse (new
 * lease id) shuts the first holder out even if it is the same key.
 *
 * A runner's result is untrusted input. It is re-shaped here: the check id
 * must be one the server would derive for that probe, the subject is the
 * run's SHA, provenance and version are the server's, every string is
 * clipped, and `file:` evidence refs (paths on the runner's disk, unreadable
 * from here) are dropped. The signature is derived here from the validated
 * check id and the runner's bounded `signatureParts` (a sent `signature` is
 * ignored), the recurrence key is the check id, severity is capped at the
 * probe's own risk, and confidence at `RUNNER_MAX_CONFIDENCE`.
 *
 * This file holds the decisions; `quality-scout-runner-host-store.ts` holds
 * the SQL, behind `ScoutRunnerHostStore`.
 */

import {
  planScoutProbe,
  scoutExecutionKey,
} from '@buildd/core/quality-scout/executors';
import { SCOUT_CHECK_VERSION, scoutCheckId, scoutExecutionCheckId } from '@buildd/core/quality-scout/ledger';
import {
  SCOUT_FLAVOR,
  SCOUT_REPRODUCIBILITY,
  type ScoutHostNeed,
  type ScoutProbeRecord,
  type ScoutReproducibility,
  type ScoutRun,
} from '@buildd/core/quality-scout/types';
import type { ScoutCapabilityProfile } from '@buildd/core/scout-capabilities';
import {
  EVIDENCE_COVERAGE,
  MAX_EVIDENCE_REFS,
  MAX_OBSERVED_CHARS,
  severityRank,
  VERIFICATION_SEVERITIES,
  VERIFICATION_VERDICTS,
  verificationSignature,
  type EvidenceShortfall,
  type VerificationEvidenceRef,
  type VerificationResult,
} from '@buildd/core/verification-check';
import type {
  ScoutHostPortsAdvert,
  ScoutHostedRun,
  ScoutProbeResultsResponse,
  ScoutRunClaimResponse,
} from '@buildd/shared';
import { SCOUT_LEASE_SLACK_MS, scoutHostNeed, type ScoutRunOutcome } from '@/lib/quality-scout-run';

// ── Bounds ──────────────────────────────────────────────────────────────────

export const MAX_SCOUT_HOST_REPOS = 200;
/** Parked runs a claim looks at before giving up. */
export const SCOUT_CLAIM_CANDIDATES = 25;
/** The whole probes request body. Command tails are already capped at 4 000 chars per stream. */
export const MAX_SCOUT_RESULTS_BODY_BYTES = 128 * 1024;
export const MAX_SCOUT_RESULTS_PER_CALL = 10;
export const MAX_SCOUT_RELEASE_REASON = 200;
const MAX_REASON_CHARS = 120;
const MAX_KEY_CHARS = 120;
const MAX_KIND_CHARS = 48;
const MAX_REF_CHARS = 200;
const MAX_SHORTFALL = 20;
/** Dedupe parts a runner may send; the server signs `[checkId, ...parts]`. */
export const MAX_SCOUT_SIGNATURE_PARTS = 20;
export const MAX_SCOUT_SIGNATURE_PART_CHARS = 120;
/**
 * A runner's own confidence is capped here, below the default filing
 * threshold (0.7). It is recorded, but never by itself verified evidence:
 * whether a runner-hosted finding files is decided by server-counted
 * recurrence (quality-scout-actions.ts `decideScoutAction`).
 */
export const RUNNER_MAX_CONFIDENCE = 0.5;
const EXECUTOR_RE = /^scout-[a-z0-9-]{1,40}$/;
const LEASE_ID_RE = /^[0-9a-f-]{36}$/i;

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ── Store ───────────────────────────────────────────────────────────────────

export interface ClaimableScoutRun {
  run: ScoutRun;
  /** `owner/name` of the workspace's linked repo, or null when it has none. */
  repo: string | null;
  /** Its runner-assigned, selected probes that have no result yet. */
  probes: ScoutProbeRecord[];
}

export interface ScoutRunnerHostStore {
  /**
   * Finalize expired parked runs of these workspaces, inside `teamId` only
   * (the hourly sweep, narrowed). Ids it finalized: never another team's.
   */
  sweepExpired(q: { teamId: string; workspaceIds: readonly string[] }): Promise<string[]>;
  /**
   * Parked runs in `teamId` and `workspaceIds`, deadline not passed, lease
   * free (never taken, or lapsed once). Oldest deadline first.
   */
  listClaimable(q: { teamId: string; workspaceIds: readonly string[]; now: Date; limit: number }): Promise<ClaimableScoutRun[]>;
  /** The atomic lease: null when another runner (or the sweep) got there first. */
  claim(q: { runId: string; teamId: string; holder: string; now: Date; leaseExpiresAt: Date }): Promise<ScoutRun | null>;
  /** The run and all its probes, only if its workspace is in `teamId`. */
  loadForTeam(runId: string, teamId: string): Promise<{ run: ScoutRun; probes: ScoutProbeRecord[] } | null>;
  /**
   * Write one runner probe's result, only while `holder` holds the run's
   * unexpired lease and the probe is runner-assigned, selected and has no
   * result. False when any of that no longer holds.
   */
  recordResult(q: { runId: string; holder: string; now: Date; candidateId: string; result: VerificationResult; reproducibility: ScoutReproducibility }): Promise<boolean>;
  /** Selected runner probes of the run still without a result. */
  remainingRunnerProbes(runId: string): Promise<number>;
  /** Atomic hand-off from `awaiting_host` (held by `holder`) to this finalize. */
  take(runId: string, holder: string): Promise<boolean>;
  /** Finalize a taken run on the server (completeScoutRun → findings → action policy → saveRun). */
  finalize(run: ScoutRun, probes: readonly ScoutProbeRecord[]): Promise<ScoutRunOutcome>;
  /** Clear the lease (back to `awaiting_host`, claimable), only for its holder. */
  release(q: { runId: string; holder: string; now: Date; reason: string }): Promise<boolean>;
}

// ── Callers ─────────────────────────────────────────────────────────────────

export interface ScoutHostCaller {
  accountId: string;
  teamId: string;
  /** Workspaces the key may claim in (canClaim links, open team workspaces, token workspace list). */
  accessibleWorkspaceIds: ReadonlySet<string>;
}

export const scoutLeaseHolder = (accountId: string, leaseId: string) => `${accountId}:${leaseId}`;

export type ScoutHostResponse<T> = { status: number; body: T | { error: string; code: string } };

const refuse = (status: number, code: string, error: string) => ({ status, body: { error, code } });

// ── Request parsing ─────────────────────────────────────────────────────────

export function parseScoutHostPorts(raw: unknown): ScoutHostPortsAdvert | null {
  if (!isRecord(raw)) return null;
  const flag = (k: string) => raw[k] === true;
  for (const k of ['command', 'capture', 'browser', 'appBoot']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return null;
  }
  return { command: flag('command'), capture: flag('capture'), browser: flag('browser'), appBoot: flag('appBoot') };
}

/** The probe needs a set of advertised ports serves. Only runner needs are ever routed here. */
export function scoutAdvertNeeds(ports: ScoutHostPortsAdvert): Set<ScoutHostNeed> {
  const out = new Set<ScoutHostNeed>();
  if (ports.command) out.add('command');
  if (ports.capture) out.add('capture');
  if (ports.appBoot) out.add('app-boot');
  return out;
}

/** Every runner probe of the run has a need, and the runner's ports serve it. A run with nothing to run is not servable. */
export function canServeScoutProbes(probes: readonly ScoutProbeRecord[], profile: ScoutCapabilityProfile, needs: ReadonlySet<ScoutHostNeed>): boolean {
  if (probes.length === 0) return false;
  return probes.every((p) => {
    const need = scoutHostNeed(p.executor, profile);
    return need !== null && needs.has(need);
  });
}

export function hostedRunOf(run: ScoutRun): ScoutHostedRun {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    missionId: run.missionId,
    trigger: run.trigger,
    mode: run.mode,
    status: 'awaiting_host',
    candidate: { ...run.candidate },
    prior: run.prior ? { ...run.prior } : null,
    budget: { ...run.budget },
    policyVersion: run.policyVersion,
    startedAt: run.startedAt,
    completedAt: null,
    error: null,
  };
}

// ── Result normalization ────────────────────────────────────────────────────

/** The check ids the server would give this probe's result: by candidate, or by its execution. */
export function expectedScoutCheckIds(probe: ScoutProbeRecord, profile: ScoutCapabilityProfile): Set<string> {
  const ids = new Set([scoutCheckId(probe.candidateId)]);
  const plan = planScoutProbe(probe, profile);
  if (plan.status === 'runnable') {
    const key = scoutExecutionKey(plan.action);
    if (key) ids.add(scoutExecutionCheckId(key));
  }
  return ids;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? clip(v, max) : null);

function refsOf(v: unknown): VerificationEvidenceRef[] {
  if (!Array.isArray(v)) return [];
  const out: VerificationEvidenceRef[] = [];
  for (const r of v) {
    if (!isRecord(r) || typeof r.kind !== 'string' || typeof r.ref !== 'string') continue;
    // A path on the runner's disk is evidence nobody here can read.
    if (r.ref.startsWith('file:')) continue;
    out.push({ kind: clip(r.kind, MAX_KIND_CHARS), ref: clip(r.ref, MAX_REF_CHARS) });
    if (out.length >= MAX_EVIDENCE_REFS) break;
  }
  return out;
}

function shortfallOf(v: unknown): EvidenceShortfall[] {
  if (!Array.isArray(v)) return [];
  const out: EvidenceShortfall[] = [];
  for (const s of v.slice(0, MAX_SHORTFALL)) {
    if (!isRecord(s) || typeof s.key !== 'string') continue;
    if (s.need !== 'complete' && s.need !== 'partial') continue;
    if (!(EVIDENCE_COVERAGE as readonly unknown[]).includes(s.have)) continue;
    out.push({ key: clip(s.key, MAX_KEY_CHARS), need: s.need, have: s.have as EvidenceShortfall['have'] });
  }
  return out;
}

/** Absent → no parts. Anything but an array of at most N strings is refused. */
function signaturePartsOf(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_SCOUT_SIGNATURE_PARTS) return null;
  if (!v.every((p) => typeof p === 'string')) return null;
  return v.map((p: string) => clip(p, MAX_SCOUT_SIGNATURE_PART_CHARS));
}

/**
 * A runner's report → the result the server stores, or why it is refused.
 * Only verdict, severity (capped at the probe's risk), confidence (capped at
 * `RUNNER_MAX_CONFIDENCE`), observation, evidence refs, reason, shortfall and
 * signature parts come from the runner, each bounded. The signature is the
 * server's: `verificationSignature([checkId, ...signatureParts])`, the same
 * construction `runVerificationCheck` uses. A `signature` or `recurrenceKey`
 * the runner sends is ignored.
 */
export function normalizeRunnerResult(
  run: ScoutRun,
  probe: ScoutProbeRecord,
  profile: ScoutCapabilityProfile,
  raw: unknown,
  now: Date,
): { ok: true; result: VerificationResult } | { ok: false; code: string } {
  if (!isRecord(raw)) return { ok: false, code: 'malformed_result' };
  const verdict = raw.verdict;
  if (!(VERIFICATION_VERDICTS as readonly unknown[]).includes(verdict)) return { ok: false, code: 'bad_verdict' };
  const parts = signaturePartsOf(raw.signatureParts);
  if (parts === null) return { ok: false, code: 'bad_signature_parts' };
  if (typeof raw.checkId !== 'string' || !expectedScoutCheckIds(probe, profile).has(raw.checkId)) return { ok: false, code: 'wrong_check' };
  // A result for another commit is not a result for this run.
  if (raw.subject !== undefined && (!isRecord(raw.subject) || raw.subject.ref !== run.candidate.sha)) return { ok: false, code: 'wrong_sha' };

  const v = verdict as VerificationResult['verdict'];
  // A runner may report a failure as less severe than the probe's risk, never more.
  const reported = (VERIFICATION_SEVERITIES as readonly unknown[]).includes(raw.severity) ? (raw.severity as NonNullable<VerificationResult['severity']>) : probe.risk;
  const severity = v === 'fail' ? (severityRank(reported) < severityRank(probe.risk) ? probe.risk : reported) : null;
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.min(RUNNER_MAX_CONFIDENCE, Math.max(0, raw.confidence))
    : null;
  const prov = isRecord(raw.provenance) ? raw.provenance : {};
  const executor = typeof prov.executor === 'string' && EXECUTOR_RE.test(prov.executor) ? prov.executor : 'scout-runner';
  const ranAtMs = typeof prov.ranAt === 'string' ? Date.parse(prov.ranAt) : NaN;
  // A runner clock can drift; never let it date a result into the future.
  const ranAt = Number.isFinite(ranAtMs) && ranAtMs <= now.getTime() ? new Date(ranAtMs).toISOString() : now.toISOString();
  const checkId = raw.checkId;
  return {
    ok: true,
    result: {
      checkId,
      checkVersion: SCOUT_CHECK_VERSION,
      subject: { kind: 'candidate-sha', ref: run.candidate.sha },
      verdict: v,
      severity,
      confidence,
      observed: str(raw.observed, MAX_OBSERVED_CHARS),
      evidenceRefs: refsOf(raw.evidenceRefs),
      reason: v === 'pass' || v === 'fail' ? null : str(raw.reason, MAX_REASON_CHARS),
      evidenceShortfall: shortfallOf(raw.evidenceShortfall),
      signature: verificationSignature([checkId, ...parts]),
      ...(parts.length > 0 ? { signatureParts: parts } : {}),
      recurrenceKey: checkId,
      provenance: { flavor: SCOUT_FLAVOR, origin: `run:${run.id}`, executor, ranAt },
    },
  };
}

// ── Claim ───────────────────────────────────────────────────────────────────

export interface ScoutClaimInput {
  caller: ScoutHostCaller;
  repos: readonly string[];
  ports: ScoutHostPortsAdvert;
  now: Date;
  /** The fleet kill switch (`QUALITY_SCOUT_DISABLED`). */
  disabled: boolean;
  newLeaseId(): string;
}

/**
 * Sweep, then lease the oldest-deadline parked run this runner can host. A
 * lost race falls through to the next candidate. The sweep runs even with the
 * kill switch on, so a parked run still ends; the claim does not.
 */
export async function claimScoutRunForRunner(input: ScoutClaimInput, store: ScoutRunnerHostStore): Promise<ScoutRunClaimResponse> {
  const workspaceIds = [...input.caller.accessibleWorkspaceIds];
  let expired: string[] = [];
  if (workspaceIds.length > 0) {
    try {
      expired = await store.sweepExpired({ teamId: input.caller.teamId, workspaceIds });
    } catch (err) {
      console.warn('[quality-scout] runner-claim sweep failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
  const tail = expired.length > 0 ? { expired } : {};
  if (input.disabled) return { run: null, reason: 'disabled', ...tail };
  if (workspaceIds.length === 0) return { run: null, reason: 'none', ...tail };

  const repoSet = new Set(input.repos.slice(0, MAX_SCOUT_HOST_REPOS).map((r) => r.toLowerCase()));
  const needs = scoutAdvertNeeds(input.ports);
  if (needs.size === 0) return { run: null, reason: 'none', ...tail };

  const candidates = await store.listClaimable({ teamId: input.caller.teamId, workspaceIds, now: input.now, limit: SCOUT_CLAIM_CANDIDATES });
  for (const c of candidates) {
    if (!c.repo || !repoSet.has(c.repo.toLowerCase())) continue;
    const parking = c.run.parking;
    if (!parking || !canServeScoutProbes(c.probes, parking.profile, needs)) continue;
    const leaseId = input.newLeaseId();
    const deadline = Date.parse(parking.hostDeadline);
    const leaseExpiresAt = new Date(Math.min(input.now.getTime() + parking.runnerMaxDurationMs + SCOUT_LEASE_SLACK_MS, deadline));
    const claimed = await store.claim({
      runId: c.run.id,
      teamId: input.caller.teamId,
      holder: scoutLeaseHolder(input.caller.accountId, leaseId),
      now: input.now,
      leaseExpiresAt,
    });
    if (!claimed) continue;
    return {
      run: hostedRunOf(claimed),
      probes: c.probes.map((p) => ({ ...p })) as unknown as Extract<ScoutRunClaimResponse, { run: ScoutHostedRun }>['probes'],
      profile: parking.profile as unknown as Record<string, unknown>,
      lease: {
        leaseId,
        expiresAt: leaseExpiresAt.toISOString(),
        runnerMaxDurationMs: parking.runnerMaxDurationMs,
        hostDeadline: parking.hostDeadline,
      },
      ...tail,
    };
  }
  return { run: null, reason: 'none', ...tail };
}

// ── Held-lease checks ───────────────────────────────────────────────────────

type HeldRun = { run: ScoutRun; probes: ScoutProbeRecord[]; holder: string };

async function loadHeld(
  caller: ScoutHostCaller,
  runId: string,
  leaseId: unknown,
  now: Date,
  store: ScoutRunnerHostStore,
): Promise<{ ok: true; held: HeldRun } | { ok: false; status: number; body: { error: string; code: string } }> {
  if (typeof leaseId !== 'string' || !LEASE_ID_RE.test(leaseId)) return { ok: false, ...refuse(400, 'lease_required', 'leaseId (the id the claim returned) is required') };
  const loaded = await store.loadForTeam(runId, caller.teamId);
  // Another team's run reads exactly like no run.
  if (!loaded || !caller.accessibleWorkspaceIds.has(loaded.run.workspaceId)) return { ok: false, ...refuse(404, 'run_not_found', 'Scout run not found') };
  const holder = scoutLeaseHolder(caller.accountId, leaseId);
  const lease = loaded.run.parking?.lease;
  if (loaded.run.status !== 'awaiting_host') return { ok: false, ...refuse(409, 'run_not_parked', `Scout run is ${loaded.run.status}, not waiting for a runner`) };
  if (!lease || lease.holder !== holder) return { ok: false, ...refuse(409, 'lease_not_held', 'This key does not hold the lease on this run') };
  if (Date.parse(lease.expiresAt) <= now.getTime()) return { ok: false, ...refuse(409, 'lease_expired', 'The lease on this run has expired') };
  return { ok: true, held: { ...loaded, holder } };
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface ScoutResultsInput {
  caller: ScoutHostCaller;
  runId: string;
  leaseId: unknown;
  results: unknown;
  now: Date;
}

/**
 * Accept results for runner-assigned probes of a run this caller holds. The
 * whole call is refused (nothing written) if any entry names another probe,
 * repeats one, is already reported, or is malformed. When the last runner
 * probe has a result, finalize on the server.
 */
export async function reportScoutProbeResults(input: ScoutResultsInput, store: ScoutRunnerHostStore): Promise<ScoutHostResponse<ScoutProbeResultsResponse>> {
  if (!Array.isArray(input.results) || input.results.length === 0) return refuse(400, 'results_required', 'results (non-empty array) is required');
  if (input.results.length > MAX_SCOUT_RESULTS_PER_CALL) return refuse(413, 'too_many_results', `At most ${MAX_SCOUT_RESULTS_PER_CALL} results per call`);
  const loaded = await loadHeld(input.caller, input.runId, input.leaseId, input.now, store);
  if (!loaded.ok) return loaded;
  const { run, probes, holder } = loaded.held;
  const profile = run.parking!.profile;
  const byId = new Map(probes.map((p) => [p.candidateId, p]));

  const accepted: Array<{ candidateId: string; result: VerificationResult; reproducibility: ScoutReproducibility }> = [];
  const seen = new Set<string>();
  for (const entry of input.results) {
    if (!isRecord(entry) || typeof entry.candidateId !== 'string') return refuse(400, 'malformed_result', 'Each result needs a candidateId');
    const id = entry.candidateId;
    if (seen.has(id)) return refuse(400, 'duplicate_probe', `Probe ${clip(id, 80)} appears twice`);
    seen.add(id);
    const probe = byId.get(id);
    if (!probe || probe.selection.status !== 'selected' || probe.host !== 'runner') {
      return refuse(422, 'probe_not_assigned', `Probe ${clip(id, 80)} is not assigned to a runner on this run`);
    }
    if (probe.result) return refuse(409, 'probe_already_reported', `Probe ${clip(id, 80)} already has a result`);
    const norm = normalizeRunnerResult(run, probe, profile, entry.result, input.now);
    if (!norm.ok) return refuse(422, norm.code, `Probe ${clip(id, 80)}: result refused (${norm.code})`);
    const rep = (SCOUT_REPRODUCIBILITY as readonly unknown[]).includes(entry.reproducibility) ? (entry.reproducibility as ScoutReproducibility) : 'unknown';
    accepted.push({ candidateId: id, result: norm.result, reproducibility: rep });
  }

  const written: string[] = [];
  for (const a of accepted) {
    const ok = await store.recordResult({ runId: run.id, holder, now: input.now, ...a });
    // Lost the lease or a concurrent call wrote it between the check and here.
    if (!ok) {
      if (written.length === 0) return refuse(409, 'lease_lost', 'The lease on this run was lost before the results were written');
      break;
    }
    written.push(a.candidateId);
  }

  const remaining = await store.remainingRunnerProbes(run.id);
  if (remaining > 0) return { status: 200, body: { accepted: written, remaining, finalized: false } };

  // The last result is in. Take the run and finalize it on the server; a
  // concurrent call that also saw zero remaining loses this take.
  const fresh = await store.loadForTeam(run.id, input.caller.teamId);
  if (!fresh || fresh.run.status !== 'awaiting_host' || !(await store.take(run.id, holder))) {
    return { status: 200, body: { accepted: written, remaining: 0, finalized: false } };
  }
  const outcome = await store.finalize(fresh.run, fresh.probes);
  return {
    status: 200,
    body: { accepted: written, remaining: 0, finalized: true, runStatus: outcome.status === 'completed' ? 'completed' : 'failed' },
  };
}

// ── Release ─────────────────────────────────────────────────────────────────

export interface ScoutReleaseInput {
  caller: ScoutHostCaller;
  runId: string;
  leaseId: unknown;
  reason: unknown;
  now: Date;
}

/** The checkout cannot serve the run's SHA: hand the run back, unclaimed. */
export async function releaseScoutRunForRunner(input: ScoutReleaseInput, store: ScoutRunnerHostStore): Promise<ScoutHostResponse<{ released: true }>> {
  if (typeof input.reason !== 'string' || !input.reason.trim()) return refuse(400, 'reason_required', 'reason (why this runner cannot serve the run) is required');
  const loaded = await loadHeld(input.caller, input.runId, input.leaseId, input.now, store);
  if (!loaded.ok) return loaded;
  const ok = await store.release({ runId: input.runId, holder: loaded.held.holder, now: input.now, reason: clip(input.reason.trim(), MAX_SCOUT_RELEASE_REASON) });
  if (!ok) return refuse(409, 'lease_lost', 'The lease on this run was lost before it could be released');
  return { status: 200, body: { released: true } };
}
