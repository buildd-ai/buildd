// Offline verification of a signed self-host license token (BUILDD_LICENSE).
//
// What this is: a deterministic, network-free check that a token was signed by
// a key the operator trusts and is inside its validity window. What this is NOT:
// copy protection. This file lives in the source-available tree; a licensee who
// may modify it can edit the check out. The token proves entitlement to a
// separately licensed module and drives its loader; it does not protect FSL code.
// See docs/specs/commercial-licensing.md.
//
// Token: base64url(header).base64url(payload).base64url(signature), JWS-style
// compact form, Ed25519 over the ASCII bytes "<header>.<payload>". Signing code
// does not exist here: the private key is held by the issuer, never by this repo.
//
// Fail-safe: every problem yields a non-'active' status with a fixed reason
// code. Reasons never echo token bytes, so they are safe to log and display.

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const LICENSE_TOKEN_TYPE = 'buildd-license';
export const LICENSE_ISSUER = 'buildd-licensing';
export const LICENSE_PAYLOAD_VERSION = 1;
export const LICENSE_EDITIONS = ['team', 'enterprise'] as const;
export const LICENSE_KINDS = ['production', 'nonprod', 'trial'] as const;
/** Payload fields this verifier understands; a `crit` entry outside this set rejects the token. */
export const KNOWN_PAYLOAD_FIELDS = [
  'v', 'iss', 'jti', 'customer', 'edition', 'features', 'limits', 'iat', 'nbf', 'exp',
  'graceDays', 'kind', 'deployment', 'crit',
] as const;

export type LicenseEdition = (typeof LICENSE_EDITIONS)[number];
export type LicenseKind = (typeof LICENSE_KINDS)[number];

/**
 * Time policy. A proposal made explicit and overridable, not a contractual
 * promise: whether a grace period exists and how long is a commercial/legal
 * decision (see the spec's decision table).
 */
export interface LicensePolicy {
  /** Grace after `exp` when the token does not say. 0 disables grace. */
  graceDays: number;
  /** Ceiling on grace, whatever the token claims. */
  maxGraceDays: number;
  /** Tolerance applied to nbf/exp for clock drift, in seconds. */
  clockSkewSeconds: number;
}

export const DEFAULT_LICENSE_POLICY: LicensePolicy = {
  graceDays: 30,
  maxGraceDays: 30,
  clockSkewSeconds: 10 * 60,
};
/** Skew is bounded so a misconfiguration cannot stretch validity unboundedly. */
export const MAX_CLOCK_SKEW_SECONDS = 60 * 60;
export const MAX_GRACE_DAYS = 90;
const MAX_TOKEN_BYTES = 8192;

export interface LicenseClaims {
  id: string;
  customerId: string;
  customerName: string | null;
  edition: LicenseEdition;
  kind: LicenseKind;
  /** Named capability claims. Code gates on these, never on `edition`. */
  features: string[];
  maxSeats: number | null;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  graceDays: number | null;
  deploymentId: string | null;
  keyId: string;
}

export type LicenseStatusKind = 'absent' | 'active' | 'grace' | 'expired' | 'not_yet_valid' | 'invalid';

export type LicenseInvalidReason =
  | 'malformed'
  | 'too_large'
  | 'unsupported_algorithm'
  | 'unsupported_type'
  | 'unknown_key_id'
  | 'bad_key'
  | 'bad_signature'
  | 'unsupported_version'
  | 'wrong_issuer'
  | 'invalid_field'
  | 'unknown_critical_field'
  | 'unknown_edition'
  | 'deployment_mismatch'
  | 'read_failed';

export interface LicenseStatus {
  status: LicenseStatusKind;
  /** Set for invalid. Fixed vocabulary; never contains token content. */
  reason?: LicenseInvalidReason;
  /** Present for active/grace/expired/not_yet_valid: the signature checked out. */
  claims?: LicenseClaims;
  /** Unix seconds when grace ends (grace and expired). */
  graceEndsAt?: number;
}

export type PublicKeySet = Record<string, string>;

/**
 * Keys the build trusts, as kid -> raw 32-byte Ed25519 public key, base64url.
 * Deliberately empty in the public tree: the production verifier key is added
 * by the owner when the issuer exists. Until then only BUILDD_LICENSE_PUBKEYS
 * (operator-supplied, e.g. air-gapped rotation) can validate anything.
 */
export const BUILT_IN_PUBLIC_KEYS: PublicKeySet = {};

type Env = Record<string, string | undefined>;

function b64urlDecode(segment: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  return Buffer.from(segment, 'base64url');
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Parse BUILDD_LICENSE_PUBKEYS (JSON object kid -> key). Bad JSON yields no extra keys. */
export function parsePublicKeyOverride(raw: string | undefined): PublicKeySet {
  if (!raw?.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: PublicKeySet = {};
    for (const [kid, key] of Object.entries(value)) if (typeof key === 'string') out[kid] = key;
    return out;
  } catch {
    return {};
  }
}

function importEd25519(rawBase64url: string): KeyObject | null {
  const raw = b64urlDecode(rawBase64url);
  if (!raw || raw.length !== 32) return null;
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rawBase64url }, format: 'jwk' });
  } catch {
    return null;
  }
}

function isIdString(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v);
}
function isUnixSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e11;
}

export function clampPolicy(policy: Partial<LicensePolicy> = {}): LicensePolicy {
  const num = (v: number | undefined, fallback: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback;
  const maxGraceDays = num(policy.maxGraceDays, DEFAULT_LICENSE_POLICY.maxGraceDays, MAX_GRACE_DAYS);
  return {
    maxGraceDays,
    graceDays: Math.min(num(policy.graceDays, DEFAULT_LICENSE_POLICY.graceDays, MAX_GRACE_DAYS), maxGraceDays),
    clockSkewSeconds: num(policy.clockSkewSeconds, DEFAULT_LICENSE_POLICY.clockSkewSeconds, MAX_CLOCK_SKEW_SECONDS),
  };
}

/** Policy from env: BUILDD_LICENSE_GRACE_DAYS (0 disables). Everything else stays default. */
export function policyFromEnv(env: Env = process.env): LicensePolicy {
  const raw = env.BUILDD_LICENSE_GRACE_DAYS?.trim();
  const days = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  return clampPolicy(days === undefined ? {} : { graceDays: days });
}

export interface VerifyOptions {
  now?: number;
  keys?: PublicKeySet;
  policy?: Partial<LicensePolicy>;
  /** This installation's id; required to match when the token is bound to one. */
  deploymentId?: string | null;
}

const invalid = (reason: LicenseInvalidReason): LicenseStatus => ({ status: 'invalid', reason });

/** Verify a token. Never throws; `now` is unix seconds. */
export function verifyLicenseToken(token: string | null | undefined, opts: VerifyOptions = {}): LicenseStatus {
  const trimmed = token?.trim();
  if (!trimmed) return { status: 'absent' };
  if (trimmed.length > MAX_TOKEN_BYTES) return invalid('too_large');

  const parts = trimmed.split('.');
  if (parts.length !== 3) return invalid('malformed');
  const [h, p, s] = parts;
  const headerBytes = b64urlDecode(h);
  const payloadBytes = b64urlDecode(p);
  const sig = b64urlDecode(s);
  if (!headerBytes || !payloadBytes || !sig) return invalid('malformed');
  const header = parseJsonObject(headerBytes);
  if (!header) return invalid('malformed');

  if (header.alg !== 'EdDSA') return invalid('unsupported_algorithm');
  if (header.typ !== LICENSE_TOKEN_TYPE) return invalid('unsupported_type');
  if (typeof header.kid !== 'string' || !isIdString(header.kid)) return invalid('malformed');

  const keys = opts.keys ?? { ...BUILT_IN_PUBLIC_KEYS, ...parsePublicKeyOverride(process.env.BUILDD_LICENSE_PUBKEYS) };
  const rawKey = Object.prototype.hasOwnProperty.call(keys, header.kid) ? keys[header.kid] : undefined;
  if (rawKey === undefined) return invalid('unknown_key_id');
  const key = importEd25519(rawKey);
  if (!key) return invalid('bad_key');

  let ok = false;
  try {
    ok = sig.length === 64 && cryptoVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), key, sig);
  } catch {
    ok = false;
  }
  if (!ok) return invalid('bad_signature');

  // The signature is good: from here the token is the issuer's own, but still validated strictly.
  const payload = parseJsonObject(payloadBytes);
  if (!payload) return invalid('malformed');
  if (payload.v !== LICENSE_PAYLOAD_VERSION) return invalid('unsupported_version');
  if (payload.iss !== LICENSE_ISSUER) return invalid('wrong_issuer');

  if (payload.crit !== undefined) {
    if (!Array.isArray(payload.crit) || !payload.crit.every((c) => typeof c === 'string')) return invalid('invalid_field');
    if (payload.crit.some((c) => !(KNOWN_PAYLOAD_FIELDS as readonly string[]).includes(c))) return invalid('unknown_critical_field');
  }

  if (!LICENSE_EDITIONS.includes(payload.edition as LicenseEdition)) return invalid('unknown_edition');
  const kind = payload.kind === undefined ? 'production' : payload.kind;
  if (!LICENSE_KINDS.includes(kind as LicenseKind)) return invalid('invalid_field');
  if (!isIdString(payload.jti)) return invalid('invalid_field');

  const customer = payload.customer as Record<string, unknown> | undefined;
  if (!customer || typeof customer !== 'object' || !isIdString(customer.id)) return invalid('invalid_field');
  if (customer.name !== undefined && (typeof customer.name !== 'string' || customer.name.length > 200)) return invalid('invalid_field');

  const features = payload.features ?? [];
  if (!Array.isArray(features) || features.length > 64 || !features.every((f) => typeof f === 'string' && /^[a-z][a-z0-9_.-]{1,47}$/.test(f))) {
    return invalid('invalid_field');
  }

  const limits = (payload.limits ?? {}) as Record<string, unknown>;
  if (typeof limits !== 'object' || Array.isArray(limits)) return invalid('invalid_field');
  const seats = limits.maxSeats;
  if (seats !== undefined && !(typeof seats === 'number' && Number.isInteger(seats) && seats >= 1 && seats <= 1_000_000)) return invalid('invalid_field');

  if (!isUnixSeconds(payload.iat) || !isUnixSeconds(payload.exp)) return invalid('invalid_field');
  const nbf = payload.nbf === undefined ? payload.iat : payload.nbf;
  if (!isUnixSeconds(nbf) || payload.exp <= nbf) return invalid('invalid_field');
  const graceDays = payload.graceDays;
  if (graceDays !== undefined && !(typeof graceDays === 'number' && Number.isInteger(graceDays) && graceDays >= 0 && graceDays <= MAX_GRACE_DAYS)) {
    return invalid('invalid_field');
  }

  let deploymentId: string | null = null;
  if (payload.deployment !== undefined) {
    const d = payload.deployment as Record<string, unknown>;
    if (!d || typeof d !== 'object' || !isIdString(d.id)) return invalid('invalid_field');
    deploymentId = d.id;
    if (opts.deploymentId !== deploymentId) return invalid('deployment_mismatch');
  }

  const claims: LicenseClaims = {
    id: payload.jti,
    customerId: customer.id,
    customerName: typeof customer.name === 'string' ? customer.name : null,
    edition: payload.edition as LicenseEdition,
    kind: kind as LicenseKind,
    features: [...new Set(features as string[])],
    maxSeats: typeof seats === 'number' ? seats : null,
    issuedAt: payload.iat,
    notBefore: nbf,
    expiresAt: payload.exp,
    graceDays: typeof graceDays === 'number' ? graceDays : null,
    deploymentId,
    keyId: header.kid,
  };

  const policy = clampPolicy(opts.policy);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = policy.clockSkewSeconds;
  if (now + skew < claims.notBefore) return { status: 'not_yet_valid', claims };
  if (now - skew <= claims.expiresAt) return { status: 'active', claims };

  const grace = Math.min(claims.graceDays ?? policy.graceDays, policy.maxGraceDays);
  const graceEndsAt = claims.expiresAt + grace * 86400;
  return now - skew <= graceEndsAt
    ? { status: 'grace', claims, graceEndsAt }
    : { status: 'expired', claims, graceEndsAt };
}

/** Read the token from BUILDD_LICENSE, else the file named by BUILDD_LICENSE_FILE. */
export function readLicenseToken(env: Env = process.env): { token: string | null; error?: 'read_failed' } {
  const inline = env.BUILDD_LICENSE?.trim();
  if (inline) return { token: inline };
  const file = env.BUILDD_LICENSE_FILE?.trim();
  if (!file) return { token: null };
  try {
    return { token: readFileSync(file, 'utf8') };
  } catch {
    return { token: null, error: 'read_failed' };
  }
}

/** Status of this installation's license from env. Never throws, never reaches the network. */
export function resolveLicenseStatus(
  env: Env = process.env,
  opts: { now?: number; deploymentId?: string | null } = {},
): LicenseStatus {
  const { token, error } = readLicenseToken(env);
  if (error) return invalid(error);
  return verifyLicenseToken(token, {
    now: opts.now,
    deploymentId: opts.deploymentId ?? env.BUILDD_DEPLOYMENT_ID?.trim() ?? null,
    keys: { ...BUILT_IN_PUBLIC_KEYS, ...parsePublicKeyOverride(env.BUILDD_LICENSE_PUBKEYS) },
    policy: policyFromEnv(env),
  });
}

/** Non-secret summary for admin read-only introspection. Omits the token, signature and key material. */
export function redactedLicenseSummary(status: LicenseStatus): Record<string, unknown> {
  const c = status.claims;
  return {
    status: status.status,
    reason: status.reason ?? null,
    edition: c?.edition ?? null,
    kind: c?.kind ?? null,
    customerName: c?.customerName ?? null,
    licenseId: c?.id ?? null,
    keyId: c?.keyId ?? null,
    features: c?.features ?? [],
    maxSeats: c?.maxSeats ?? null,
    expiresAt: c?.expiresAt ?? null,
    graceEndsAt: status.graceEndsAt ?? null,
    deploymentBound: c ? c.deploymentId !== null : null,
  };
}
