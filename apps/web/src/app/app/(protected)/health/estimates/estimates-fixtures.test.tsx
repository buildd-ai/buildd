import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EstimatesClient } from './EstimatesClient';
import { ESTIMATES_FIXTURE_STATES, FIXTURE_READOUTS, isEstimatesFixtureState } from './estimates-fixtures';

const render = (state: keyof typeof FIXTURE_READOUTS) =>
  renderToStaticMarkup(<EstimatesClient readout={FIXTURE_READOUTS[state]} canManage />);

describe('estimates fixtures', () => {
  test('recognises only known states', () => {
    expect(isEstimatesFixtureState('enabled')).toBe(true);
    expect(isEstimatesFixtureState('bogus')).toBe(false);
    expect(isEstimatesFixtureState(undefined)).toBe(false);
  });

  test('every enabled state has a readout and the error/off states do not', () => {
    for (const s of ESTIMATES_FIXTURE_STATES) {
      expect(s in FIXTURE_READOUTS).toBe(s.startsWith('enabled'));
    }
  });

  test('each fixture shows the variant the visual audit names', () => {
    expect(render('enabled-empty')).toContain('Not enough finished tasks to assess estimates.');
    expect(render('enabled-few')).toContain('4 finished so far.');
    expect(render('enabled-ten')).toContain('7 in 10 tasks finished within the upper estimate.');
    expect(render('enabled')).toContain('Across 40 finished tasks.');
    expect(render('enabled-overrun')).toContain('Typically ran 1.5x longer than estimated.');
    expect(render('enabled-underrun')).toContain('Typically ran 1.7x shorter than estimated.');
    expect(render('enabled-limited-history')).toContain('6 of these had little history in the repo to go on.');
    expect(render('enabled')).not.toContain('estimates-limited-history');
  });
});
