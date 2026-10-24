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

/**
 * Registered checks under each R/AC, using the same ownership rules as check:
 * and screen:. Malformed owned declarations throw, so a required check cannot
 * silently disappear. Different detectors may share a criterion; an id may
 * occur only once per criterion, even if repeated with identical settings.
 */
export function criterionVerifications(body: string): CriterionVerification[] {
  const { bindings, refused } = criterionBindings(body);
  if (refused.length) {
    const first = refused[0]!;
    throw new Error(`${first.criterionId}: verify must be a registered binding (${first.reason})`);
  }
  return bindings.map((canonical) => {
    const binding = toRegisteredBinding(canonical);
    if (!binding) throw new Error(`${canonical.criterionId}: verify must be a registered production binding`);
    return { criterionId: canonical.criterionId, binding, fingerprint: bindingFingerprint(canonical) };
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

/** Both declaration forms are normalized through the same registry and identity. */
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

/** Built-in executable contract. Legacy names are aliases, never separate registrations. */
export const REGISTERED_VERIFIER_REGISTRY: VerifierRegistry = {
  verifiers: [
    { id: 'ui.action-state', version: 1, method: 'deterministic', evidence: ['ui.text', 'ui.actions', 'ui.state'] },
    { id: 'ui.copy', version: 1, method: 'model', evidence: ['ui.text', 'ui.actions'] },
  ],
  profiles: [{ id: 'buildd-ui', version: 1 }],
};

function canonicalVerifier(v: VerifierIdentity): VerifierIdentity {
  if (v.version !== 1) return v;
  return { ...v, id: v.id === 'ui.actions_match_state' ? 'ui.action-state' : v.id === 'ui.card_clarity' ? 'ui.copy' : v.id };
}

function canonicalProfile(v: VerifierIdentity): VerifierIdentity {
  return v.id === 'buildd.enterprise' && v.version === 1 ? { id: 'buildd-ui', version: 1 } : v;
}

/** Compatibility adapter for existing production executors; unsupported profiles stay refused. */
export function toRegisteredBinding(b: VerificationBinding): RegisteredBinding | null {
  const verifier = canonicalVerifier(b.verifier);
  const profile = canonicalProfile(b.profile);
  if (verifier.version !== 1 || profile.id !== 'buildd-ui' || profile.version !== 1) return null;
  const id = verifier.id === 'ui.action-state' ? 'ui.actions_match_state' : verifier.id === 'ui.copy' ? 'ui.card_clarity' : null;
  return id ? { id, version: 1, profile: 'buildd.enterprise@1', mode: b.mode } : null;
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
  let verifier: VerifierIdentity | null;
  let profile: VerifierIdentity | null;
  let mode: unknown;
  let evidence: string[] | null = null;
  const text = value.replace(/`/g, '').trim();
  if (text.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return 'malformed'; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed';
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 4 || keys.some((k) => !['id', 'version', 'profile', 'mode'].includes(k))
      || typeof record.id !== 'string' || typeof record.version !== 'number'
      || typeof record.profile !== 'string') return 'malformed';
    verifier = identity(`${record.id}@${record.version}`);
    profile = identity(record.profile);
    mode = record.mode;
  } else {
    const fields = new Map<string, string>();
    for (const token of text.split(/\s+/)) {
      const eq = token.indexOf('=');
      const key = eq > 0 ? token.slice(0, eq) : '';
      if (!(BINDING_KEYS as readonly string[]).includes(key) || fields.has(key)) return 'malformed';
      fields.set(key, token.slice(eq + 1));
    }
    verifier = identity(fields.get('verifier'));
    profile = identity(fields.get('profile'));
    mode = fields.get('mode');
    evidence = (fields.get('evidence') ?? '').split(',');
    if (!evidence.length || evidence.some((e) => !EVIDENCE.test(e))
      || new Set(evidence).size !== evidence.length) return 'malformed';
  }
  if (!verifier || !profile || (mode !== 'required' && mode !== 'advisory')) return 'malformed';
  verifier = canonicalVerifier(verifier);
  profile = canonicalProfile(profile);
  const known = registry.verifiers.find((v) => v.id === verifier.id && v.version === verifier.version);
  if (!known) return 'unknown_verifier';
  if (!registry.profiles.some((p) => p.id === profile.id && p.version === profile.version)) return 'unknown_profile';
  // Legacy JSON did not declare capabilities: preserve exactly its verifier's minimum.
  evidence ??= [...known.evidence];
  if (known.evidence.some((e) => !evidence.includes(e))) return 'incompatible_evidence';
  return { criterionId, verifier, profile, mode, evidence };
}

/** Every owned declaration, including legacy JSON, is accepted or refused explicitly. */
export function criterionBindings(body: string, registry: VerifierRegistry = REGISTERED_VERIFIER_REGISTRY): { bindings: VerificationBinding[]; refused: RefusedBinding[] } {
  const bindings: VerificationBinding[] = [];
  const refused: RefusedBinding[] = [];
  const seen = new Set<string>();
  for (const { criterionId, value } of criterionLines(body, 'verify')) {
    const read = readBinding(criterionId, value, registry);
    if (typeof read === 'string') { refused.push({ criterionId, value, reason: read }); continue; }
    const key = `${criterionId}:${read.verifier.id}@${read.verifier.version}`;
    if (seen.has(key)) refused.push({ criterionId, value, reason: 'malformed' });
    else { seen.add(key); bindings.push(read); }
  }
  return { bindings, refused };
}

/** The `verify:` line criterionBindings reads back as this binding. */
export function bindingLine(b: VerificationBinding): string {
  return `verify: verifier=${b.verifier.id}@${b.verifier.version} profile=${b.profile.id}@${b.profile.version} mode=${b.mode} evidence=${b.evidence.join(',')}`;
}

/** Stable SHA-256 of the binding's complete identity: criterion, verifier, profile, mode and evidence. */
export function bindingFingerprint(b: VerificationBinding): string {
  const verifier = canonicalVerifier(b.verifier);
  const profile = canonicalProfile(b.profile);
  return sha256Sync(JSON.stringify([b.criterionId, verifier.id, verifier.version, profile.id, profile.version, b.mode, [...b.evidence].sort()]));
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
  const unsupported = new Set(refused.map((r) => r.criterionId));
  return specCriteria(body).map(({ id: criterionId }) => ({
    criterionId,
    coverage: unsupported.has(criterionId) ? 'unsupported' : accepted.has(criterionId) ? 'registered' : commands.has(criterionId) ? 'command' : 'none',
  }));
}
