/**
 * Central model certification: can Buildd safely launch a catalog model?
 *
 * The live catalog (model-catalog.ts) tells us a model exists and what it
 * costs. It does not tell us whether Claude Code can launch it, or which CLI
 * version it needs. Until now that second half was a hand-edited table
 * (`MODEL_MIN_CLI_VERSION`), and a release newer than every row in it was
 * refused until someone shipped a deploy adding one.
 *
 * Certification replaces that release step. A trusted runner (the probe) launches
 * the model once with a one-turn prompt and reports what happened:
 *   - it ran: the model is `certified`, and the runner's CLI version is the
 *     lowest one known to serve it (`minVerifiedCliVersion`);
 *   - the API refused it with "version A.B.C or newer is required": the model is
 *     `incompatible` with that runner, and A.B.C is its floor (`minCliVersion`),
 *     straight from the provider. A runner at or above it probes next;
 *   - anything else (auth, rate limit, network, unknown id): `failed`, retried
 *     with backoff. A failed probe never blocks the catalog or another model.
 *
 * A model with no record and no static floor is `discovered`: it is not served
 * from the catalog until a probe certifies it. A model the static table already
 * covers (a recorded floor, or released no later than the newest recorded
 * model) is certified by `baseline` and never probed.
 *
 * Certification is Buildd-wide. Whether a team MOVES to a certified model is the
 * team's adoption policy (model-upgrade-policy.ts), not this module's call.
 *
 * Pure: records, the catalog and the clock come in as arguments. Persistence is
 * model-certification-store.ts.
 */

/**
 * Compares two dot-separated numeric version strings, e.g. "2.1.251".
 * Returns -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`. Missing trailing
 * components compare as 0 ("2.1" == "2.1.0").
 */
export function compareCliVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const na = partsA[i] ?? 0;
    const nb = partsB[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export type CertificationState = 'discovered' | 'probing' | 'certified' | 'incompatible' | 'failed';

/** How a model was deprecated: the provider catalog's expiry date, or a platform admin. */
export interface ModelDeprecation {
  source: 'catalog' | 'admin';
  /** ISO time the deprecation was recorded. */
  at: string;
  /** ISO time the model stops being served, when known. */
  retiresAt?: string | null;
  note?: string | null;
}

/** One model's stored certification record (system_cache `model_cert:<id>`). */
export interface ModelCertification {
  model: string;
  state: Exclude<CertificationState, 'discovered'>;
  /** Floor named by the provider's own version-gate error. Authoritative when set. */
  minCliVersion?: string | null;
  /** Lowest CLI version a probe launched the model with. */
  minVerifiedCliVersion?: string | null;
  /** ISO time of the first successful probe. */
  certifiedAt?: string | null;
  /** ISO time a running worker last hit a compatibility error on this model. Restarts soak. */
  lastIncidentAt?: string | null;
  /** Release time from the catalog, unix seconds, when known. */
  releasedAt?: number | null;
  contextLength?: number | null;
  deprecated?: ModelDeprecation | null;
  probe: {
    attempts: number;
    leaseId?: string | null;
    /** ISO; a lease past this is abandoned and can be taken again. */
    leaseUntil?: string | null;
    lastProbedAt?: string | null;
    lastCliVersion?: string | null;
    lastError?: string | null;
    /** ISO; a failed model is not offered to a probe before this. */
    nextProbeAt?: string | null;
  };
  /** Set when a platform admin set the state by hand. */
  override?: { by: string; at: string; note?: string | null } | null;
}

export type CertificationMap = ReadonlyMap<string, ModelCertification>;

/** How long a probe lease holds before another runner may take the model. */
export const PROBE_LEASE_MS = 10 * 60 * 1000;
const FAILED_BACKOFF_BASE_MS = 60 * 60 * 1000;
const FAILED_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** The record for `model`, matching a dated snapshot to its base id. */
export function findCertification(
  certs: CertificationMap | null | undefined,
  model: string,
): ModelCertification | null {
  if (!certs || certs.size === 0) return null;
  return certs.get(model) ?? certs.get(model.replace(/-\d{8}$/, '')) ?? null;
}

/**
 * The CLI version a runner must report to be handed `cert`'s model: the
 * provider's floor when a probe learned it, else the lowest version seen
 * launching it (conservative: an older CLI may also work, nobody checked).
 */
export function certifiedFloor(cert: ModelCertification): string | null {
  return cert.minCliVersion ?? cert.minVerifiedCliVersion ?? null;
}

export function isCertified(cert: ModelCertification | null | undefined): cert is ModelCertification {
  return !!cert && cert.state === 'certified';
}

/**
 * Can a runner reporting `runnerCliVersion` launch a certified model?
 * Fails CLOSED on a missing runner version: this only gates the catalog step,
 * where the alternative is the previous in-band release, not a deferral.
 */
export function runnerMeetsCertification(
  cert: ModelCertification,
  runnerCliVersion: string | null | undefined,
): boolean {
  if (!isCertified(cert)) return false;
  const floor = certifiedFloor(cert);
  if (!floor) return true;
  if (!runnerCliVersion) return false;
  return compareCliVersions(runnerCliVersion, floor) >= 0;
}

/** Time a model has been certified, for soak: from certification or the last incident, whichever is later. */
export function soakStart(cert: ModelCertification): number | null {
  const at = [cert.certifiedAt, cert.lastIncidentAt]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((n) => Number.isFinite(n));
  return at.length ? Math.max(...at) : null;
}

/** A model past its retirement date: never picked, and a pin to it is flagged. */
export function isRetired(cert: ModelCertification | null | undefined, now: number): boolean {
  const r = cert?.deprecated?.retiresAt;
  return !!r && Date.parse(r) <= now;
}

// ── Probe outcomes ───────────────────────────────────────────────────────────

/** "Claude Code 2.1.238 does not support this model; version 2.1.251 or newer is required." */
const VERSION_GATE = /does not support this model[^0-9]*?(\d+\.\d+\.\d+)\s+or newer/i;
/** The CLI or API does not know the id at all. */
const UNKNOWN_MODEL = /unrecognized_model|not_found_error|model[^.]*not found|invalid model|unknown model/i;

/** The CLI floor a compatibility error names, or null. */
export function parseRequiredCliVersion(error: string | null | undefined): string | null {
  if (!error) return null;
  return VERSION_GATE.exec(error)?.[1] ?? null;
}

export type ProbeErrorKind = 'version_gate' | 'unknown_model' | 'transient';

export function classifyProbeError(error: string): ProbeErrorKind {
  if (parseRequiredCliVersion(error)) return 'version_gate';
  if (UNKNOWN_MODEL.test(error)) return 'unknown_model';
  return 'transient';
}

export interface ProbeReport {
  model: string;
  cliVersion: string;
  ok: boolean;
  error?: string | null;
}

/** A fresh record for a model first offered to a probe. */
export function newCertification(
  model: string,
  catalog?: { created?: number; contextLength?: number } | null,
): ModelCertification {
  return {
    model,
    state: 'probing',
    releasedAt: catalog?.created || null,
    contextLength: catalog?.contextLength ?? null,
    probe: { attempts: 0 },
  };
}

/**
 * Apply a probe's result to the model's record. Never downgrades a certified
 * model on a transient error: one runner's bad network is not evidence about
 * the model. A version-gate error on a certified model raises its floor,
 * which keeps runners below it off the model without uncertifying it.
 */
export function applyProbeReport(
  prev: ModelCertification,
  report: ProbeReport,
  now: number,
): ModelCertification {
  const iso = new Date(now).toISOString();
  const attempts = prev.probe.attempts + 1;
  const probe = {
    ...prev.probe,
    attempts,
    leaseId: null,
    leaseUntil: null,
    lastProbedAt: iso,
    lastCliVersion: report.cliVersion,
    lastError: report.ok ? null : (report.error ?? 'probe failed').slice(0, 500),
    nextProbeAt: null as string | null,
  };

  if (report.ok) {
    const verified = prev.minVerifiedCliVersion;
    return {
      ...prev,
      state: 'certified',
      certifiedAt: prev.certifiedAt ?? iso,
      minVerifiedCliVersion:
        !verified || compareCliVersions(report.cliVersion, verified) < 0 ? report.cliVersion : verified,
      probe,
    };
  }

  const kind = classifyProbeError(report.error ?? '');
  if (kind === 'version_gate') {
    const floor = parseRequiredCliVersion(report.error)!;
    const minCliVersion =
      prev.minCliVersion && compareCliVersions(prev.minCliVersion, floor) > 0 ? prev.minCliVersion : floor;
    return {
      ...prev,
      state: prev.state === 'certified' ? 'certified' : 'incompatible',
      minCliVersion,
      probe,
    };
  }

  if (prev.state === 'certified') return { ...prev, probe };
  const backoff = Math.min(FAILED_BACKOFF_BASE_MS * 2 ** (attempts - 1), FAILED_BACKOFF_MAX_MS);
  return { ...prev, state: 'failed', probe: { ...probe, nextProbeAt: new Date(now + backoff).toISOString() } };
}

/**
 * A running worker hit a compatibility error on `model`. Records the incident
 * (which restarts soak for teams that wait) and learns the floor when the error
 * names one. Only ever makes the record more conservative.
 */
export function applyCompatibilityIncident(
  prev: ModelCertification,
  error: string,
  now: number,
): ModelCertification {
  const floor = parseRequiredCliVersion(error);
  const minCliVersion =
    floor && (!prev.minCliVersion || compareCliVersions(floor, prev.minCliVersion) > 0) ? floor : prev.minCliVersion ?? null;
  return { ...prev, minCliVersion, lastIncidentAt: new Date(now).toISOString() };
}

/**
 * Should a runner at `cliVersion` probe this model now? (No record = yes.)
 *   - a live lease belongs to someone else: no;
 *   - failed: once its backoff has passed;
 *   - incompatible: when this runner meets the floor the provider named;
 *   - certified with no provider floor: when this runner is OLDER than the
 *     lowest verified version, so the floor can come down (or be learned).
 */
export function needsProbe(
  cert: ModelCertification | null,
  cliVersion: string,
  now: number,
): boolean {
  if (!cert) return true;
  if (cert.override) return false;
  if (cert.probe.leaseUntil && Date.parse(cert.probe.leaseUntil) > now) return false;
  switch (cert.state) {
    case 'probing':
      return true; // lease expired: the previous probe never reported
    case 'failed':
      return !cert.probe.nextProbeAt || Date.parse(cert.probe.nextProbeAt) <= now;
    case 'incompatible':
      return !!cert.minCliVersion && compareCliVersions(cliVersion, cert.minCliVersion) >= 0;
    case 'certified': {
      if (cert.minCliVersion) return false;
      const v = cert.minVerifiedCliVersion;
      return !!v && compareCliVersions(cliVersion, v) < 0 && cert.probe.lastCliVersion !== cliVersion;
    }
  }
}

/** Take the probe lease on a record. */
export function leaseCertification(
  cert: ModelCertification,
  leaseId: string,
  now: number,
): ModelCertification {
  return {
    ...cert,
    state: cert.state === 'certified' ? 'certified' : 'probing',
    probe: { ...cert.probe, leaseId, leaseUntil: new Date(now + PROBE_LEASE_MS).toISOString() },
  };
}

/** A platform admin's manual verdict (escape hatch for a broken probe), or a deprecation mark. */
export function applyAdminMark(
  prev: ModelCertification,
  mark: {
    by: string;
    state?: 'certified' | 'incompatible' | null;
    minCliVersion?: string | null;
    deprecated?: boolean;
    retiresAt?: string | null;
    note?: string | null;
  },
  now: number,
): ModelCertification {
  const iso = new Date(now).toISOString();
  let next: ModelCertification = { ...prev };
  if (mark.state) {
    next = {
      ...next,
      state: mark.state,
      certifiedAt: mark.state === 'certified' ? (prev.certifiedAt ?? iso) : prev.certifiedAt ?? null,
      override: { by: mark.by, at: iso, note: mark.note ?? null },
    };
  }
  if (mark.minCliVersion !== undefined) next.minCliVersion = mark.minCliVersion;
  if (mark.deprecated === true) {
    next.deprecated = { source: 'admin', at: iso, retiresAt: mark.retiresAt ?? null, note: mark.note ?? null };
  } else if (mark.deprecated === false) {
    next.deprecated = null;
  }
  return next;
}
