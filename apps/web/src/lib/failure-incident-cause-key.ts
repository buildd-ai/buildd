/**
 * Failure incident cause keys (operator-recovery spec §4.1).
 *
 * A cause is a group of incidents that share one underlying fault, possibly
 * across workspaces and teams. Its key is computed from the incident alone, so
 * grouping never waits on a model:
 *
 *   causeKey = 'c1:' + sha256(family | causeCode | scope | discriminator).slice(0, 20)
 *
 *  - family: the incident's rule.
 *  - causeCode: the assessment's `cause.reasonCode` when assessed, otherwise
 *    the incident's `reasonCode`. A different causeCode is a different cause.
 *  - scope: `ws:<id>` for a fault that lives in one repo (a path-overlap
 *    blocker PR, a retry lineage); `platform` for one whose discriminator is
 *    not workspace-bound (an error family, a gate, a provider, the sentinel's
 *    own health).
 *  - discriminator: the signature with its `ws=` segment removed, normalised
 *    per family. Error families key on the failure-family slug the signature
 *    already carries (`toFrictionSignature` / `gateFrictionSignature`), never
 *    on raw error text.
 *
 * Membership is stored on the assessment (`recovery.causeGroup`), written by
 * `planRecovery` through the incident CAS. A rule key always exists; an
 * operator regroup or a promoted model merge overrides it until the incident's
 * own rule key changes, at which point the override is marked superseded.
 *
 * Pure. No DB, no clock unless passed.
 */
import { createHash } from 'node:crypto';
import type { FailureIncident, FailureIncidentRule, FailureRecoveryCauseGroup } from '@buildd/shared';

export const CAUSE_KEY_VERSION = 'c1';

export type CauseScope = 'platform' | `ws:${string}`;

/** Families whose discriminator names something that only exists inside one workspace. */
const WORKSPACE_SCOPED_RULES: ReadonlySet<FailureIncidentRule> = new Set(['path_overlap_stall', 'retry_fork', 'lineage_multi_pr']);

type CauseInput = Pick<FailureIncident, 'rule' | 'reasonCode' | 'signature' | 'workspaceId'> & {
  recovery?: { cause?: { reasonCode?: string } | null } | null;
};

/** The signature's segments after `<rule>` and `ws=<id>`. */
function signatureTail(signature: string): string[] {
  const parts = signature.split('|');
  return parts.slice(1).filter(p => !p.startsWith('ws='));
}

export function causeScope(i: Pick<CauseInput, 'rule' | 'workspaceId'> & { signature?: string; impact?: Record<string, number> | null }): CauseScope {
  if (i.rule === 'infrastructure_failure') return infrastructureScope(i);
  return WORKSPACE_SCOPED_RULES.has(i.rule) && i.workspaceId ? `ws:${i.workspaceId}` : 'platform';
}

/**
 * failure-incident-recovery §18.4: a worker component lives in one workspace
 * (a runner's login, a workspace's credential, its tasks' lost sessions),
 * except a team-wide credential every workspace shares, which is one cause
 * across them. Other components (the capture pipeline, §16.3) are platform.
 */
function infrastructureScope(i: { workspaceId: string | null; signature?: string; impact?: Record<string, number> | null }): CauseScope {
  const component = signatureTail(i.signature ?? '').find(p => p.startsWith('component='))?.slice('component='.length) ?? '';
  if (!component.startsWith('worker.') || !i.workspaceId) return 'platform';
  if (component === 'worker.auth' && (i.impact?.sharedCredential ?? 0) > 0) return 'platform';
  return `ws:${i.workspaceId}`;
}

/**
 * The per-family discriminator (§4.1). `impact` is accepted for families that
 * may later carry their slug there; today every family's signature has it.
 */
export function causeDiscriminator(rule: FailureIncidentRule, signature: string, _impact?: Record<string, number> | null): string {
  const tail = signatureTail(signature);
  switch (rule) {
    case 'path_overlap_stall': {
      const blocker = tail.find(p => p.startsWith('blocker='));
      return blocker ?? 'blocker=unknown';
    }
    case 'repeated_failure':
      // The friction slug (or the sentinel's reserved self-health segment). Never raw text.
      return tail[0] ?? '-';
    case 'failure_rate_spike':
      // The rule carries no error family; every spike is one platform cause.
      return tail[0] ?? 'spike';
    case 'stranded_gate': {
      const gate = (tail.find(p => p.startsWith('gate=')) ?? 'gate=-').slice('gate='.length);
      const reason = tail.find(p => !p.startsWith('gate=')) ?? '-';
      return `gate=${gate}|reason=${reason}`;
    }
    default:
      return tail.join('|') || '-';
  }
}

/** The incident's cause code: the assessment's refined one when assessed. */
export function causeCodeOf(i: CauseInput): string {
  return i.recovery?.cause?.reasonCode || i.reasonCode;
}

export function causeKeyFrom(parts: { family: string; causeCode: string; scope: string; discriminator: string }): string {
  const hash = createHash('sha256')
    .update([parts.family, parts.causeCode, parts.scope, parts.discriminator].join('|'))
    .digest('hex');
  return `${CAUSE_KEY_VERSION}:${hash.slice(0, 20)}`;
}

/** The deterministic rule key for one incident. */
export function ruleCauseKey(i: CauseInput & { impact?: Record<string, number> | null }): string {
  return causeKeyFrom({
    family: i.rule,
    causeCode: causeCodeOf(i),
    scope: causeScope(i),
    discriminator: causeDiscriminator(i.rule, i.signature, i.impact ?? null),
  });
}

/**
 * The membership to store with the next assessment. The rule key is always
 * recomputed; an operator or model membership survives while the rule key it
 * was assigned against still holds, and is marked superseded once it changes
 * (a new causeCode is a different cause).
 */
export function nextCauseGroup(
  prior: FailureRecoveryCauseGroup | null | undefined,
  ruleKey: string,
  now: string,
): FailureRecoveryCauseGroup {
  if (!prior || prior.source === 'rule') {
    return prior && prior.key === ruleKey && !prior.supersededBy
      ? prior
      : { key: ruleKey, source: 'rule', decisionId: null, confidence: null, assignedAt: now, ruleKey };
  }
  if (prior.ruleKey && prior.ruleKey !== ruleKey) {
    return { key: ruleKey, source: 'rule', decisionId: null, confidence: null, assignedAt: now, ruleKey };
  }
  return { ...prior, ruleKey: prior.ruleKey ?? ruleKey };
}

/** The key an incident groups under right now: stored membership if any, else its rule key. */
export function effectiveCauseKey(i: CauseInput & { impact?: Record<string, number> | null; recovery?: { causeGroup?: FailureRecoveryCauseGroup | null } | null }): {
  key: string; source: FailureRecoveryCauseGroup['source']; decisionId: string | null; confidence: number | null;
} {
  const rule = ruleCauseKey(i);
  const g = i.recovery?.causeGroup;
  if (!g || g.source === 'rule' || (g.ruleKey && g.ruleKey !== rule)) return { key: rule, source: 'rule', decisionId: null, confidence: null };
  // A model grouping applies while `buildd.operator_cause_merge` is live; switching the kind off stops new merges.
  if (g.source === 'model' && !MODEL_GROUPING_APPLIES) return { key: rule, source: 'rule', decisionId: null, confidence: null };
  return { key: g.supersededBy ?? g.key, source: g.source, decisionId: g.decisionId, confidence: g.confidence };
}

/**
 * `buildd.operator_cause_merge` is live from its first deploy (owner decision
 * 2026-10-11: no shadow period). A model merge only ever joins two rule keys,
 * never splits one, and an operator regroup always wins over it.
 */
export const MODEL_GROUPING_APPLIES = true;
