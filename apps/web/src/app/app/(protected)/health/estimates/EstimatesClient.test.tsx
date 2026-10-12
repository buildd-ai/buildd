import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EstimatesClient } from './EstimatesClient';
import type { TaskEstimateReadout } from '@buildd/core/task-estimate-accuracy';

const score = (scored: number, withinP80: number | null, medianRatio: number | null = 1) =>
  ({ n: scored, scored, withinP80, medianRatio, medianAbsLogError: 0.2 });
/** A readout with every breakdown filled, so the test proves the page leaves them out. */
const readout = (over: Partial<TaskEstimateReadout> = {}): TaskEstimateReadout => ({
  estimatorVersion: 'blend-v1', rows: 40, overall: score(40, 0.9), tokens: score(40, 0.8), repairs: null,
  bySource: [{ key: 'neighbours', score: score(30, 0.9) }, { key: 'prior', score: score(10, 0.6) }],
  byKind: [{ key: 'feature', score: score(25, 0.9) }],
  byCluster: [{ key: 'apps/web/missions', score: score(12, 0.95) }],
  byHistory: [{ band: '0-4', score: score(8, 0.6) }, { band: '5+', score: score(32, 0.95) }],
  indeterminate: false, ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

describe('EstimatesClient', () => {
  test('10+ scored: one lead, its sample and the limited-history count', () => {
    const html = renderToStaticMarkup(<EstimatesClient readout={readout()} canManage={false} />);
    expect(html).toContain('9 in 10 tasks finished within the upper estimate.');
    expect(html).toContain('Across 40 finished tasks.');
    expect(html).toContain('10 of these had little history in the repo to go on.');
    expect(html).not.toMatch(/uppercase|font-mono/);
  });

  test('no chart, no Details, no breakdowns, no tokens and no model terms (AC-12)', () => {
    for (const r of [readout(), readout({ overall: score(4, 0.5) }), readout({ overall: score(0, null, null), bySource: [], indeterminate: true })]) {
      for (const canManage of [true, false]) {
        const html = renderToStaticMarkup(<EstimatesClient readout={r} canManage={canManage} />);
        expect(html).not.toMatch(/<svg|<details|<table|<ul/);
        expect(html).not.toMatch(/estimates-scatter|estimates-details|estimates-row/);
        expect(text(html)).not.toMatch(/p50|p80|prior|cluster|blend|tokens|apps\/web\/missions|learning curve|last \d+ days|\bn \d/i);
      }
    }
  });

  test('0 scored: the lead alone (AC-9)', () => {
    const html = renderToStaticMarkup(<EstimatesClient readout={readout({ overall: score(0, null, null), bySource: [], indeterminate: true })} canManage={false} />);
    expect(html).toContain('Not enough finished tasks to assess estimates.');
    expect(html).not.toContain('estimates-sample');
    expect(html).not.toMatch(/in 10/);
  });

  test('1 and 9 scored: the count and no rate (AC-9)', () => {
    for (const n of [1, 9]) {
      const html = renderToStaticMarkup(<EstimatesClient readout={readout({ overall: score(n, 1, 2) })} canManage={false} />);
      expect(html).toContain('Not enough finished tasks to assess estimates.');
      expect(html).toContain(`${n} finished so far.`);
      expect(html).not.toMatch(/in 10|Typically/);
    }
  });

  test('overrun and underrun show the typical line', () => {
    expect(renderToStaticMarkup(<EstimatesClient readout={readout({ overall: score(20, 0.5, 1.5) })} canManage={false} />))
      .toContain('Typically ran 1.5x longer than estimated.');
    expect(renderToStaticMarkup(<EstimatesClient readout={readout({ overall: score(20, 0.9, 0.6) })} canManage={false} />))
      .toContain('Typically ran 1.7x shorter than estimated.');
  });

  test('member and owner see the same numbers; only the owner gets the settings link (AC-14)', () => {
    const member = renderToStaticMarkup(<EstimatesClient readout={readout()} canManage={false} />);
    const owner = renderToStaticMarkup(<EstimatesClient readout={readout()} canManage />);
    const numbers = (html: string) => text(html).match(/\d+/g);
    expect(owner).toContain('href="/app/settings/features"');
    expect(member).not.toContain('href=');
    expect(numbers(owner)).toEqual(numbers(member));
  });
});
