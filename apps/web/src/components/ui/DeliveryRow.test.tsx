import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import DeliveryRow, { deliveryAgo, deliveryTag, STANDALONE_TAG, type DeliveryItem } from './DeliveryRow';
import DeliveryCard from './DeliveryCard';
import { STAGE_METER_STATES } from './StageMeter';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

const inVerify: DeliveryItem = {
  id: 't1',
  title: 'wsl migrate stops a foreground runner',
  href: '/app/tasks/t1',
  updatedAt: NOW - 4 * 60_000,
  meter: { state: 'verify' },
  missionTitle: 'Windows runner',
  failingCheck: null,
};

const fixing: DeliveryItem = {
  ...inVerify,
  id: 't2',
  title: 'Refresh Honest queue from dev',
  href: '/app/tasks/t2',
  meter: { state: 'fixing-in-verify', fixRounds: 1 },
  missionTitle: 'Honest queue',
  failingCheck: 'CI failed',
};

const row = (d: DeliveryItem) => renderToStaticMarkup(<DeliveryRow delivery={d} now={NOW} />);
const card = (d: DeliveryItem) => renderToStaticMarkup(<DeliveryCard delivery={d} now={NOW} />);

const field = (h: string, id: string) => h.match(new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`))?.[1];
const meter = (h: string) => h.match(/data-state="([^"]+)" data-stage="([^"]+)"/)?.slice(1).join('@');
const marks = (h: string) => [...h.matchAll(/data-pattern="([^"]+)"(?: data-mark="([^"]*)")?/g)].map(m => m[0]).join('|');
/** The text a person reads, tags stripped. */
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('DeliveryRow (spec 9430a28f r2 R-10)', () => {
  it('AC-8: a delivery in verify shows the meter, the title, one tag and the time, nothing else', () => {
    const h = row(inVerify);
    expect(meter(h)).toBe('verify@verify');
    expect(field(h, 'delivery-title')).toBe(inVerify.title);
    expect(field(h, 'delivery-tag')).toBe('Windows runner');
    expect(field(h, 'delivery-time')).toBe('4m');
    expect(h.match(/data-testid="delivery-tag"/g)).toHaveLength(1);
    // The visible text is exactly title, tag and time: no sha, actor, sentence or New pill.
    expect(text(h)).toBe('wsl migrate stops a foreground runner Windows runner 4m');
    expect(h).not.toMatch(/\bNew\b|Unattributed|[0-9a-f]{7,40}/);
  });

  it('is a link to the task page, reachable from the keyboard', () => {
    const h = row(inVerify);
    expect(h).toMatch(/^<a [^>]*href="\/app\/tasks\/t1"/);
    expect(h).not.toContain('tabindex="-1"');
    expect(h).toContain('focus-visible:outline');
    expect(h).toMatch(/aria-label="wsl migrate stops a foreground runner\. Verifying\. Windows runner\. 4m ago"/);
  });

  it('AC-9: the tag is the mission when not being fixed, names the failing check while fixing, and returns to the mission once the fix lands', () => {
    expect(field(row(inVerify), 'delivery-tag')).toBe('Windows runner');
    expect(field(row(fixing), 'delivery-tag')).toBe('Honest queue · CI failed');
    const landed: DeliveryItem = { ...fixing, meter: { state: 'verify' } };
    expect(field(row(landed), 'delivery-tag')).toBe('Honest queue');
  });

  it('AC-9: a failing check only shows while the meter is in a fixing state', () => {
    for (const state of STAGE_METER_STATES) {
      const tag = deliveryTag({ ...fixing, meter: { state } });
      expect(tag.includes('CI failed')).toBe(state === 'fixing-in-build' || state === 'fixing-in-verify');
    }
  });

  it('tags standalone work as standalone, never Unattributed', () => {
    expect(deliveryTag({ ...inVerify, missionTitle: null })).toBe(STANDALONE_TAG);
    expect(deliveryTag({ ...fixing, missionTitle: null })).toBe(`${STANDALONE_TAG} · CI failed`);
  });

  it('times the latest movement: now, minutes, hours, days', () => {
    expect(deliveryAgo(NOW - 20_000, NOW)).toBe('now');
    expect(deliveryAgo(NOW - 31 * 60_000, NOW)).toBe('31m');
    expect(deliveryAgo(NOW - 5 * 3_600_000, NOW)).toBe('5h');
    expect(deliveryAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d');
    expect(deliveryAgo(NOW + 5_000, NOW)).toBe('now');
  });
});

describe('DeliveryCard (spec 9430a28f r2 R-11)', () => {
  it('AC-10: a row and a card for the same delivery agree on meter, title, tag and time', () => {
    for (const state of STAGE_METER_STATES) {
      for (const d of [inVerify, fixing]) {
        const one: DeliveryItem = { ...d, meter: { ...d.meter, state, stage: 'verify' } };
        const r = row(one);
        const c = card(one);
        expect(meter(c)).toBe(meter(r)!);
        expect(marks(c)).toBe(marks(r));
        for (const f of ['delivery-title', 'delivery-tag', 'delivery-time']) expect(field(c, f)).toBe(field(r, f)!);
        expect(c.match(/aria-label="([^"]+)"/)?.[1]).toBe(r.match(/aria-label="([^"]+)"/)![1]);
      }
    }
  });

  it('is a card link to the task page with the same four things and nothing else', () => {
    const h = card(fixing);
    expect(h).toMatch(/^<a [^>]*href="\/app\/tasks\/t2"/);
    expect(h).toContain('card-interactive');
    expect(text(h)).toBe('↻1 4m Refresh Honest queue from dev Honest queue · CI failed');
  });
});
