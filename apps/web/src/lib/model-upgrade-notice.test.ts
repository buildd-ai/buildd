import { describe, it, expect } from 'bun:test';
import { buildModelUpgradeNotice } from './model-upgrade-notice';
import type { AdoptionReport } from '@buildd/core/model-tier-adoption-report';
import type { ModelUpgradeMode } from '@buildd/core/model-upgrade-policy';
import type { TierAdoption } from '@buildd/core/model-upgrade-policy';

const tier = (o: Partial<TierAdoption>): TierAdoption => ({
  tier: 'budget', model: 'claude-haiku-4-5', selectedBy: 'catalog', why: '', newer: null, withheld: null, deprecated: null, ...o,
});
const report = (mode: ModelUpgradeMode, tiers: TierAdoption[]): AdoptionReport => ({
  policy: { policy: { mode, adoptedThrough: '2026-10-01T00:00:00Z' }, source: mode === 'latest-compatible' ? 'default' : 'team' },
  tiers,
});
const NEWER = { newer: { model: 'claude-haiku-5-5', certifiedAt: '2026-10-05T00:00:00Z' } };
const DEPRECATED = { deprecated: { source: 'catalog' as const, at: '2026-10-07T00:00:00Z', retiresAt: '2026-12-01T00:00:00Z', retired: false } };

describe('buildModelUpgradeNotice', () => {
  it('nothing for latest-compatible catalog tiers — they move on their own', () => {
    expect(buildModelUpgradeNotice(report('latest-compatible', [tier({ ...NEWER, ...DEPRECATED })]))).toBeNull();
    expect(buildModelUpgradeNotice(report('latest-compatible', [tier({})]))).toBeNull();
  });

  it('manual: names current and newer model, why it did not move, and offers adopt', () => {
    const n = buildModelUpgradeNotice(report('manual', [tier({ ...NEWER, withheld: { reason: 'manual', eligibleAt: null } })]))!;
    expect(n.kind).toBe('newer');
    expect(n.items[0].text).toContain('Haiku 5.5');
    expect(n.items[0].text).toContain('Haiku 4.5');
    expect(n.items[0].text).toContain('manual');
    expect(n.canAdopt).toBe(true);
  });

  it('soak: says when it will move, and offers no adopt button', () => {
    const n = buildModelUpgradeNotice(report('soak', [tier({ ...NEWER, withheld: { reason: 'soak', eligibleAt: '2026-10-09T00:00:00Z' } })]))!;
    expect(n.items[0].text).toContain('soak policy moves it on Oct 9');
    expect(n.canAdopt).toBe(false);
  });

  it('a pinned tier warns even under latest-compatible', () => {
    const n = buildModelUpgradeNotice(report('latest-compatible', [tier({ selectedBy: 'pinned_team', ...NEWER, withheld: { reason: 'pinned', eligibleAt: null } })]))!;
    expect(n.items[0].text).toContain('pinned');
    expect(n.canAdopt).toBe(false);
  });

  it('deprecated outranks newer-available and states the retirement', () => {
    const n = buildModelUpgradeNotice(report('manual', [
      tier({ ...NEWER, ...DEPRECATED, withheld: { reason: 'manual', eligibleAt: null } }),
      tier({ tier: 'standard', model: 'claude-sonnet-5', ...{ newer: { model: 'claude-sonnet-5-5', certifiedAt: null } }, withheld: { reason: 'manual', eligibleAt: null } }),
    ]))!;
    expect(n.kind).toBe('deprecated');
    expect(n.items).toHaveLength(1);
    expect(n.items[0].text).toContain('retires Dec 1');
    expect(n.subjectKey.startsWith('model-upgrade:deprecated:')).toBe(true);
  });

  it('a snoozed "newer" notice does not hide a later deprecation of the same model', () => {
    const before = buildModelUpgradeNotice(report('manual', [tier({ ...NEWER, withheld: { reason: 'manual', eligibleAt: null } })]))!;
    const after = buildModelUpgradeNotice(report('manual', [tier({ ...NEWER, ...DEPRECATED, withheld: { reason: 'manual', eligibleAt: null } })]))!;
    expect(after.subjectKey).not.toBe(before.subjectKey);
  });

  it('never shows ids beyond model display names', () => {
    const n = buildModelUpgradeNotice(report('manual', [tier({ ...NEWER, withheld: { reason: 'manual', eligibleAt: null } })]))!;
    expect(n.items[0].text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
