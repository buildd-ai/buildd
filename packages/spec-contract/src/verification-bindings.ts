import { criterionChecks, criterionLines, criterionScreens } from './check-lines';
import { sha256Sync } from './hash';
import { specCriteria } from './requirements';

/** A registered verifier selected by an immutable spec revision, never by an agent's report. */
export interface RegisteredBinding {
  id: 'ui.actions_match_state' | 'ui.card_clarity';
  version: 1;
  profile: 'buildd.enterprise@1';
  mode: 'required' | 'advisory';
}

export interface CriterionVerification {
  criterionId: string;
  binding: RegisteredBinding;
  fingerprint: string;
}

// SHA-256 of JSON.stringify({ id, version, profile, mode }), in that field order.
// The accepted domain has four values. Keeping their digests here preserves a
// synchronous, browser-portable contract without a runtime crypto dependency.
// Tests recompute every digest; a new verifier/version/profile must add its identity.
const FINGERPRINTS: Record<RegisteredBinding['id'], Record<RegisteredBinding['mode'], string>> = {
  'ui.actions_match_state': {
    required: 'ffc325f5782d0a117564efc87001725ee9c24701e424c16d6f74f5e75d0f8907',
    advisory: '0bb949e50af6c25ee4c77277cbf0e7116736b788fb4e26227d243dd74151a68a',
  },
  'ui.card_clarity': {
    required: 'b4ced2cb050e7d910e8ac5d2c5fbcbc8d9e523084d110781894969d07b8da91e',
    advisory: '4491f1819cdb698ee6a7104aa40fb343935f0a7fc212aef337104dc3e4552e60',
  },
};

function parseBinding(value: string, criterionId: string): RegisteredBinding {
  const invalid = () => new Error(`${criterionId}: verify must be a registered id, version, profile and mode JSON object`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 4 || keys.some((key) => !['id', 'version', 'profile', 'mode'].includes(key))
    || (record.id !== 'ui.actions_match_state' && record.id !== 'ui.card_clarity')
    || record.version !== 1 || record.profile !== 'buildd.enterprise@1'
    || (record.mode !== 'required' && record.mode !== 'advisory')) throw invalid();
  return { id: record.id, version: record.version, profile: record.profile, mode: record.mode };
}

/**
 * Registered checks under each R/AC, using the same ownership rules as check:
 * and screen:. Malformed owned declarations throw, so a required check cannot
 * silently disappear. Different detectors may share a criterion; an id may
 * occur only once per criterion, even if repeated with identical settings.
 */
export function criterionVerifications(body: string): CriterionVerification[] {
  const seen = new Set<string>();
  return criterionLines(body, 'verify').map(({ criterionId, value }) => {
    const binding = parseBinding(value, criterionId);
    const key = `${criterionId}:${binding.id}`;
    if (seen.has(key)) throw new Error(`${criterionId}: duplicate verify registration for ${binding.id}`);
    seen.add(key);
    return { criterionId, binding, fingerprint: FINGERPRINTS[binding.id][binding.mode] };
  });
}

/** One capture a registered check needs: a named UI scenario at one viewport. */
export interface VerificationScenario { scenarioId: string; viewport: 'mobile' | 'desktop' }

/** At most this many captures per criterion: what one registered run may judge. */
export const MAX_VERIFICATION_SCENARIOS = 8;
const SCENARIO = /^([a-z0-9][a-z0-9-]{0,99})@(mobile|desktop)$/;

/**
 * The captures each criterion's registered checks need, from `scenarios:`
 * lines under it (same ownership rule as `verify:`):
 *
 *   - AC-2: A closed PR offers nothing to merge.
 *     verify: {"id":"ui.actions_match_state","version":1,"profile":"buildd.enterprise@1","mode":"required"}
 *     scenarios: closed-pr@mobile, closed-pr@desktop
 *
 * A check passes only when every declared capture was judged: a convenient
 * subset never certifies the criterion. Several lines add up; repeats are
 * dropped; a malformed item throws, like a malformed binding.
 */
export function criterionVerificationScenarios(body: string): Map<string, VerificationScenario[]> {
  const out = new Map<string, VerificationScenario[]>();
  for (const { criterionId, value } of criterionLines(body, 'scenarios')) {
    const list = out.get(criterionId) ?? [];
    for (const item of value.split(',').map((x) => x.replace(/`/g, '').trim())) {
      const m = SCENARIO.exec(item);
      if (!m) throw new Error(`${criterionId}: scenarios must be <scenario>@mobile or <scenario>@desktop items, comma-separated`);
      if (!list.some((s) => s.scenarioId === m[1] && s.viewport === m[2])) list.push({ scenarioId: m[1]!, viewport: m[2] as VerificationScenario['viewport'] });
    }
    if (list.length > MAX_VERIFICATION_SCENARIOS) throw new Error(`${criterionId}: at most ${MAX_VERIFICATION_SCENARIOS} scenarios`);
    out.set(criterionId, list);
  }
  return out;
}

/**
 * Why a revision body's verification declarations cannot be stored or pinned,
 * or null when they can: every `verify:` parses, names its captures on a
 * `scenarios:` line, and no `scenarios:` line stands under a criterion with no
 * `verify:`. A body with neither is unaffected.
 */
export function verificationDeclarationError(body: string): string | null {
  try {
    const bound = new Set(criterionVerifications(body).map((v) => v.criterionId));
    const scenarios = criterionVerificationScenarios(body);
    for (const id of bound) {
      if (!scenarios.get(id)?.length) return `${id}: a verify binding must name the captures it needs on a scenarios: line (e.g. scenarios: closed-pr@mobile)`;
    }
    for (const id of scenarios.keys()) {
      if (!bound.has(id)) return `${id}: scenarios is declared, but the criterion has no verify binding`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid verification declaration';
  }
}

export interface CriterionVerificationCoverage {
  criterionId: string;
  command: boolean;
  visual: boolean;
  registered: boolean;
  /** Declaration coverage only; says nothing about execution or a verdict. */
  status: 'declared' | 'missing';
}

/** Every R/AC in body order, including those with no declared verification. */
export function criterionVerificationCoverage(body: string): CriterionVerificationCoverage[] {
  const commands = new Set(criterionChecks(body).map((check) => check.criterionId));
  const screens = new Set(criterionScreens(body).filter((check) => check.screens.length > 0).map((check) => check.criterionId));
  const registrations = new Set(criterionVerifications(body).map((check) => check.criterionId));
  return specCriteria(body).map(({ id: criterionId }) => {
    const command = commands.has(criterionId);
    const visual = screens.has(criterionId);
    const registered = registrations.has(criterionId);
    return { criterionId, command, visual, registered, status: command || visual || registered ? 'declared' : 'missing' };
  });
}

/*
 * The key=value form of a `verify:` line, checked against a registry of
 * verifiers and profiles rather than a fixed list:
 *
 *   verify: verifier=<id>@<version> profile=<id>@<version> mode=<required|advisory> evidence=<a>,<b>
 *
 * Pure, like the JSON form above, and read by the same ownership rule as
 * `check:` (nearest R-n / AC-n above it; fenced blocks skipped). A JSON value
 * on a `verify:` line belongs to criterionVerifications and is not read here.
 * Nothing is dropped: every line is either a binding or a refusal with a reason.
 */

export interface VerifierIdentity { id: string; version: number }

/** One registered binding as declared under its criterion. */
export interface VerificationBinding {
  criterionId: string;
  verifier: VerifierIdentity;
  profile: VerifierIdentity;
  mode: 'required' | 'advisory';
  evidence: string[];
}

export interface RegisteredVerifier extends VerifierIdentity {
  method: 'deterministic' | 'model' | 'visual';
  /** Evidence capabilities the verifier cannot run without. */
  evidence: readonly string[];
}

/** What the host can run: verifiers and project profiles, each at exact versions. */
export interface VerifierRegistry {
  verifiers: readonly RegisteredVerifier[];
  profiles: readonly VerifierIdentity[];
}

export type BindingRefusal = 'malformed' | 'unknown_verifier' | 'unknown_profile' | 'incompatible_evidence';
export interface RefusedBinding { criterionId: string; value: string; reason: BindingRefusal }

const IDENTITY = /^([a-z0-9][a-z0-9._-]{0,99})@([1-9][0-9]{0,5})$/i;
const EVIDENCE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const BINDING_KEYS = ['verifier', 'profile', 'mode', 'evidence'] as const;

const identity = (v: string | undefined): VerifierIdentity | null => {
  const m = v ? IDENTITY.exec(v) : null;
  return m ? { id: m[1]!, version: Number(m[2]) } : null;
};

function readBinding(criterionId: string, value: string, registry: VerifierRegistry): VerificationBinding | BindingRefusal {
  const fields = new Map<string, string>();
  for (const token of value.replace(/`/g, '').trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    const key = eq > 0 ? token.slice(0, eq) : '';
    if (!(BINDING_KEYS as readonly string[]).includes(key) || fields.has(key)) return 'malformed';
    fields.set(key, token.slice(eq + 1));
  }
  const verifier = identity(fields.get('verifier'));
  const profile = identity(fields.get('profile'));
  const mode = fields.get('mode');
  const evidence = (fields.get('evidence') ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  if (!verifier || !profile || (mode !== 'required' && mode !== 'advisory') || !evidence.length
    || evidence.some((e) => !EVIDENCE.test(e)) || new Set(evidence).size !== evidence.length) return 'malformed';
  const known = registry.verifiers.find((v) => v.id === verifier.id && v.version === verifier.version);
  if (!known) return 'unknown_verifier';
  if (!registry.profiles.some((p) => p.id === profile.id && p.version === profile.version)) return 'unknown_profile';
  if (known.evidence.some((e) => !evidence.includes(e))) return 'incompatible_evidence';
  return { criterionId, verifier, profile, mode, evidence };
}

/** Every key=value binding the body declares, and every one it refuses, by reason. */
export function criterionBindings(body: string, registry: VerifierRegistry): { bindings: VerificationBinding[]; refused: RefusedBinding[] } {
  const bindings: VerificationBinding[] = [];
  const refused: RefusedBinding[] = [];
  for (const { criterionId, value } of criterionLines(body, 'verify')) {
    if (value.trim().startsWith('{')) continue;
    const read = readBinding(criterionId, value, registry);
    if (typeof read === 'string') refused.push({ criterionId, value, reason: read });
    else bindings.push(read);
  }
  return { bindings, refused };
}

/** The `verify:` line criterionBindings reads back as this binding. */
export function bindingLine(b: VerificationBinding): string {
  return `verify: verifier=${b.verifier.id}@${b.verifier.version} profile=${b.profile.id}@${b.profile.version} mode=${b.mode} evidence=${b.evidence.join(',')}`;
}

/** Stable SHA-256 of the binding's complete identity: criterion, verifier, profile, mode and evidence. */
export function bindingFingerprint(b: VerificationBinding): string {
  return sha256Sync(JSON.stringify([b.criterionId, b.verifier.id, b.verifier.version, b.profile.id, b.profile.version, b.mode, [...b.evidence].sort()]));
}

export type CoverageKind = 'command' | 'registered' | 'unsupported' | 'none';

/**
 * How each criterion is covered, in body order. A refused binding reads
 * `unsupported` even beside a command, so a broken declaration stays visible;
 * a criterion with nothing declared reads `none`. Never a verdict.
 */
export function verificationCoverage(body: string, registry: VerifierRegistry): Array<{ criterionId: string; coverage: CoverageKind }> {
  const commands = new Set(criterionChecks(body).map((c) => c.criterionId));
  const { bindings, refused } = criterionBindings(body, registry);
  const accepted = new Set(bindings.map((b) => b.criterionId));
  for (const { criterionId, value } of criterionLines(body, 'verify')) {
    if (!value.trim().startsWith('{')) continue;
    try { parseBinding(value, criterionId); accepted.add(criterionId); } catch { refused.push({ criterionId, value, reason: 'malformed' }); }
  }
  const unsupported = new Set(refused.map((r) => r.criterionId));
  return specCriteria(body).map(({ id: criterionId }) => ({
    criterionId,
    coverage: unsupported.has(criterionId) ? 'unsupported' : accepted.has(criterionId) ? 'registered' : commands.has(criterionId) ? 'command' : 'none',
  }));
}
