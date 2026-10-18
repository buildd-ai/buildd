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
    expect(render('enabled-ten')).toContain('Upper estimate coverage: 70% (80% target).');
    expect(render('enabled')).toContain('Across 40 finished tasks.');
    expect(render('enabled-overrun')).toContain('Actual / p50: 1.5x.');
    expect(render('enabled-underrun')).toContain('Actual / p50: 0.6x.');
    expect(render('enabled-limited-history')).toContain('6 of these had limited comparable history in the repo.');
    expect(render('enabled')).not.toContain('estimates-limited-history');
  });
});
