import { describe, expect, it } from 'bun:test';
import { deliveryBlock, deliveryChecks } from './mission-delivery-checks';
import type { CheckRow } from './mission-checks';

const base = (over: Partial<CheckRow>): CheckRow => ({
  key: 'x', kind: 'visual', label: 'x', chip: null, blocks: true, status: 'queued', state: 'queued', detail: null, target: null,
  commit: null, actor: 'system', problem: null, findings: null, repairs: [], evidence: [], ...over,
});
const visual = (over: Partial<CheckRow> = {}) => base({ key: 'visual', kind: 'visual', label: 'Visual review', status: 'waived', state: 'waived', commit: '90df389', screens: 0, ...over });
const pr = (over: Partial<CheckRow> = {}) => base({ key: 'mission-pr', kind: 'mission_pr', status: 'running', state: 'reviewer deciding', evidence: [{ label: 'Open the PR', href: 'https://github.com/o/r/pull/5701' }], ...over });
const release = (over: Partial<CheckRow> = {}) => base({ key: 'release', kind: 'release', status: 'queued', state: 'waiting', ...over });
const ctx = { prNumber: 5701, tier: 'agent-review' as const, target: 'dev', releaseHref: '/app/releases/r1', screensHref: '/app/missions/m?visualReview=1' };

describe('deliveryChecks (I-22)', () => {
  it('reads the three example rows', () => {
    const rows = deliveryChecks([visual(), pr(), release()], ctx);
    expect(rows.map(r => [r.name, r.stateWord, r.detail])).toEqual([
      ['Visual review', 'Skipped', '0 screens · 90df389'],
      ['Merge into dev', 'In review', '#5701'],
      ['Release', 'Queued', 'after #5701'],
    ]);
    expect(rows.map(r => r.status)).toEqual(['skipped', 'running', 'queued']);
    expect(rows[1].href).toBe('https://github.com/o/r/pull/5701');
    expect(rows[2].href).toBe('/app/releases/r1');
  });

  it('human merge with the review approved reads Needs review; changes requested is in the detail', () => {
    const [r] = deliveryChecks([pr({ status: 'owner', state: 'approve to deliver' })], { ...ctx, tier: 'human' });
    expect([r.status, r.stateWord, r.detail]).toEqual(['review', 'Needs review', '#5701']);
  });

  it('a passed visual review, a merged PR and a failed release', () => {
    const rows = deliveryChecks([visual({ status: 'passed', state: 'passed', screens: 6 }), pr({ status: 'passed', state: 'merged' }), release({ status: 'finding', state: 'deploy failed', target: 'v0.318' })], ctx);
    expect(rows.map(r => [r.status, r.stateWord])).toEqual([['passed', 'Passed'], ['passed', 'Passed'], ['failed', 'Failed']]);
    expect(rows[0].detail).toBe('6 screens · 90df389');
    expect(rows[2].detail).toBe('v0.318 · deploy');
  });

  it('a check that does not apply is not shown, and no sentence appears', () => {
    const rows = deliveryChecks([visual({ status: 'not_applicable', state: 'not needed', detail: 'No screens changed, so there was nothing to check.' })], ctx);
    expect(rows).toEqual([]);
    const text = JSON.stringify(deliveryChecks([visual(), pr(), release()], ctx));
    expect(text).not.toMatch(/reviewer|Merges when|Starts after|No screens/);
  });

  it('only the visual review row can be skipped, and only while waivable', () => {
    const rows = deliveryChecks([visual({ status: 'queued', state: 'queued', waivable: true }), pr(), release()], ctx);
    expect(rows.map(r => !!r.skippable)).toEqual([true, false, false]);
  });

  it('marks the first step not yet passed or skipped as current', () => {
    const rows = deliveryChecks([visual(), pr(), release()], ctx);
    expect(rows.map(r => r.current)).toEqual([false, true, false]);
  });
});

const t = (id: string, o: Partial<{ status: string; prUrl: string | null; prNumber: number | null; prMerged: boolean; prClosed: boolean }> = {}) =>
  ({ id, title: `Task ${id}`, status: 'completed', prUrl: null, prNumber: null, prMerged: false, prClosed: false, ...o });

describe('deliveryBlock (I-23, AC-30)', () => {
  it('counts merged, open and no-PR on one mono line, with a row per PR', () => {
    const tasks = [
      ...Array.from({ length: 5 }, (_, i) => t(`m${i}`, { prUrl: `u${i}`, prNumber: 10 + i, prMerged: true })),
      t('o', { prUrl: 'uo', prNumber: 20 }),
      ...Array.from({ length: 7 }, (_, i) => t(`n${i}`)),
    ];
    const b = deliveryBlock(tasks)!;
    expect(b.line).toBe('5 merged · 1 open · 7 no PR');
    expect(b.prs).toHaveLength(6);
    expect(b.prs[5]).toMatchObject({ number: 20, status: 'queued' });
    expect(b.prs[0]).toMatchObject({ number: 10, status: 'passed' });
  });

  it('leaves zero counts out', () => {
    expect(deliveryBlock([t('a', { prUrl: 'u', prNumber: 1, prMerged: true })])!.line).toBe('1 merged');
  });

  it('renders nothing with no PR and no count', () => {
    expect(deliveryBlock([])).toBeNull();
    expect(deliveryBlock([t('a', { status: 'cancelled' })])).toBeNull();
  });

  it('a closed PR reads skipped, and counts in neither merged nor open', () => {
    const b = deliveryBlock([t('a', { prUrl: 'u', prNumber: 1, prClosed: true })])!;
    expect(b.prs[0].status).toBe('skipped');
    expect(b.line).toBe('');
  });
});
