/**
 * The Home notice for a tier left on a deprecated or superseded model.
 *
 * Shown only when something will NOT fix itself: a tier the team's upgrade
 * policy holds back (manual or soak), or a pinned tier. A latest-compatible,
 * catalog-resolved tier moves on its own, so it never produces a notice.
 *
 * Freshness: re-derived from the live adoption report on every Home render,
 * never stored. Snoozing keys on the exact (kind, tier, model, newer model)
 * set, so a snooze of "newer available" does not hide a later deprecation, and
 * a snooze of one release does not hide the next one.
 */
import { getModelDisplayName } from '@buildd/core/model-display';
import type { AdoptionReport } from '@buildd/core/model-adoption-report';
import type { ModelUpgradeMode, TierAdoption } from '@buildd/core/model-upgrade-policy';

export interface ModelUpgradeNoticeItem {
  tier: string;
  text: string;
}

export interface ModelUpgradeNotice {
  /** `deprecated` outranks `newer`: a model is going away. */
  kind: 'deprecated' | 'newer';
  headline: string;
  items: ModelUpgradeNoticeItem[];
  /** One-click adopt is offered only under the manual policy (soak and pins adopt differently). */
  canAdopt: boolean;
  subjectKey: string;
}

const TIER_LABEL: Record<string, string> = {
  'premium-plus': 'Premium+',
  premium: 'Premium',
  standard: 'Standard',
  budget: 'Budget',
};

function day(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}

function reasonText(t: TierAdoption, mode: ModelUpgradeMode): string {
  if (t.selectedBy === 'pinned_team' || t.selectedBy === 'pinned_workspace' || t.withheld?.reason === 'pinned') {
    return 'the tier is pinned to it';
  }
  if (t.withheld?.reason === 'soak' || mode === 'soak') {
    return t.withheld?.eligibleAt ? `your soak policy moves it on ${day(t.withheld.eligibleAt)}` : 'your soak policy is still waiting';
  }
  return 'your upgrade policy is manual';
}

/** Does this tier need a person? Only when the policy or a pin keeps it where it is. */
function heldBack(t: TierAdoption, mode: ModelUpgradeMode): boolean {
  const pinned = t.selectedBy === 'pinned_team' || t.selectedBy === 'pinned_workspace';
  if (pinned) return true;
  if (t.selectedBy !== 'catalog') return false; // default / policy service: nothing the team set
  return mode !== 'latest-compatible';
}

export function buildModelUpgradeNotice(report: AdoptionReport): ModelUpgradeNotice | null {
  const mode = report.policy.policy.mode;
  const deprecated: TierAdoption[] = [];
  const newer: TierAdoption[] = [];
  for (const t of report.tiers) {
    if (!heldBack(t, mode)) continue;
    if (t.deprecated) deprecated.push(t);
    else if (t.newer && t.withheld) newer.push(t);
  }
  if (deprecated.length === 0 && newer.length === 0) return null;

  const kind: ModelUpgradeNotice['kind'] = deprecated.length ? 'deprecated' : 'newer';
  const shown = kind === 'deprecated' ? deprecated : newer;
  const items = shown.map((t) => {
    const tier = TIER_LABEL[t.tier] ?? t.tier;
    const current = getModelDisplayName(t.model);
    const next = t.newer ? getModelDisplayName(t.newer.model) : null;
    if (kind === 'deprecated') {
      const when = t.deprecated?.retired
        ? 'has been retired'
        : t.deprecated?.retiresAt ? `is deprecated and retires ${day(t.deprecated.retiresAt)}` : 'is deprecated';
      return {
        tier: t.tier,
        text: `${tier} runs ${current}, which ${when}.` +
          (next ? ` ${next} is certified; it did not move because ${reasonText(t, mode)}.` : ` It stays because ${reasonText(t, mode)}.`),
      };
    }
    return {
      tier: t.tier,
      text: `${next} is certified. ${tier} stays on ${current} because ${reasonText(t, mode)}.`,
    };
  });

  const headline = kind === 'deprecated'
    ? (shown.length === 1 ? 'A tier model is being retired' : `${shown.length} tier models are being retired`)
    : (shown.length === 1 ? 'A newer model is available' : `${shown.length} newer models are available`);

  const key = shown
    .map((t) => `${t.tier}=${t.model}>${t.newer?.model ?? ''}`)
    .sort()
    .join(',');
  return {
    kind,
    headline,
    items,
    canAdopt: mode === 'manual' && shown.some((t) => t.newer && t.withheld?.reason === 'manual'),
    subjectKey: `model-upgrade:${kind}:${key}`,
  };
}
