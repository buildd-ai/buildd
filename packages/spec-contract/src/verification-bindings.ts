import { criterionChecks, criterionLines, criterionScreens } from './check-lines';
import { specCriteria } from './requirements';

/** A registered verifier selected by an immutable spec revision, never by an agent's report. */
export interface VerificationBinding {
  id: 'ui.actions_match_state' | 'ui.card_clarity';
  version: 1;
  profile: 'buildd.enterprise@1';
  mode: 'required' | 'advisory';
}

export interface CriterionVerification {
  criterionId: string;
  binding: VerificationBinding;
  fingerprint: string;
}

// SHA-256 of JSON.stringify({ id, version, profile, mode }), in that field order.
// The accepted domain has four values. Keeping their digests here preserves a
// synchronous, browser-portable contract without a runtime crypto dependency.
// Tests recompute every digest; a new verifier/version/profile must add its identity.
const FINGERPRINTS: Record<VerificationBinding['id'], Record<VerificationBinding['mode'], string>> = {
  'ui.actions_match_state': {
    required: 'ffc325f5782d0a117564efc87001725ee9c24701e424c16d6f74f5e75d0f8907',
    advisory: '0bb949e50af6c25ee4c77277cbf0e7116736b788fb4e26227d243dd74151a68a',
  },
  'ui.card_clarity': {
    required: 'b4ced2cb050e7d910e8ac5d2c5fbcbc8d9e523084d110781894969d07b8da91e',
    advisory: '4491f1819cdb698ee6a7104aa40fb343935f0a7fc212aef337104dc3e4552e60',
  },
};

function parseBinding(value: string, criterionId: string): VerificationBinding {
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
