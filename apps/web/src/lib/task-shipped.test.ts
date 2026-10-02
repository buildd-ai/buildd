import { describe, expect, it } from 'bun:test';
import { authorShippedOf, buildTaskShippedRecord, parseTaskShippedRecord } from './task-shipped';

const NOW = new Date('2026-01-02T00:00:00.000Z');
const GOOD = 'A finished task now opens on a plain sentence about what changed. Checked at phone and desktop width.';

const build = (authorShipped: unknown, over: Partial<Parameters<typeof buildTaskShippedRecord>[0]> = {}) =>
  buildTaskShippedRecord({ authorShipped, changeType: 'frontend', prNumber: 12, sensitive: false, now: NOW, ...over });

describe('buildTaskShippedRecord', () => {
  it('keeps a plain lede, the server change type and the PR it was read from', () => {
    const { record, ledeRejection } = build({ lede: GOOD, offPlan: ['The desktop pass was left for later.'] });
    expect(ledeRejection).toBeNull();
    expect(record).toEqual({
      version: 1,
      lede: GOOD,
      changeType: 'frontend',
      offPlan: ['The desktop pass was left for later.'],
      prNumber: 12,
      computedAt: NOW.toISOString(),
    });
  });

  it('drops a lede that names a file or symbol, and its off-plan lines with it', () => {
    const { record, ledeRejection } = build({ lede: 'Added TaskShippedHeader to page.tsx.', offPlan: ['x'] });
    expect(ledeRejection).not.toBeNull();
    expect(record.lede).toBeNull();
    expect(record.offPlan).toEqual([]);
    expect(record.changeType).toBe('frontend');
  });

  it('never stores prose for a sensitive workspace', () => {
    const { record } = build({ lede: GOOD, offPlan: ['x'] }, { sensitive: true });
    expect(record.lede).toBeNull();
    expect(record.offPlan).toEqual([]);
  });

  it('records the change type alone when no lede was written', () => {
    const { record, ledeRejection } = build(null, { changeType: 'backend' });
    expect(ledeRejection).toBeNull();
    expect(record.lede).toBeNull();
    expect(record.changeType).toBe('backend');
  });

  it('never takes a change type from the model', () => {
    const { record } = build({ lede: GOOD, changeType: 'backend' }, { changeType: null });
    expect(record.changeType).toBeNull();
  });
});

describe('authorShippedOf', () => {
  it('reads structuredOutput.shipped', () => {
    expect(authorShippedOf({ shipped: { lede: GOOD } }, 'agent')).toEqual({ lede: GOOD });
  });
  it('ignores a session that ended on runner-captured fallback text', () => {
    expect(authorShippedOf({ shipped: { lede: GOOD } }, 'fallback')).toBeNull();
  });
  it('is null for missing or malformed output', () => {
    expect(authorShippedOf(null, 'agent')).toBeNull();
    expect(authorShippedOf([], 'agent')).toBeNull();
    expect(authorShippedOf({ handoff: {} }, 'agent')).toBeNull();
  });
});

describe('parseTaskShippedRecord', () => {
  it('round-trips a stored record', () => {
    const { record } = build({ lede: GOOD });
    expect(parseTaskShippedRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });
  it('rejects anything that is not a version-1 record', () => {
    expect(parseTaskShippedRecord(null)).toBeNull();
    expect(parseTaskShippedRecord({ lede: GOOD })).toBeNull();
    expect(parseTaskShippedRecord({ version: 2, lede: GOOD })).toBeNull();
  });
  it('sanitises a malformed change type and off-plan list', () => {
    const r = parseTaskShippedRecord({ version: 1, lede: ' ', changeType: 'sideways', offPlan: ['a', 3, 'b', 'c'] })!;
    expect(r.lede).toBeNull();
    expect(r.changeType).toBeNull();
    expect(r.offPlan).toEqual(['a', 'b']);
  });
});
