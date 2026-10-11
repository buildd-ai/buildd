import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EstimatesClient } from './EstimatesClient';
import { FIXTURE_EMPTY_READOUT, FIXTURE_POINTS, FIXTURE_READOUT, isEstimatesFixtureState } from './estimates-fixtures';

describe('estimates fixtures', () => {
  test('recognises only known states', () => {
    expect(isEstimatesFixtureState('enabled')).toBe(true);
    expect(isEstimatesFixtureState('bogus')).toBe(false);
    expect(isEstimatesFixtureState(undefined)).toBe(false);
  });
  test('enabled renders details; empty does not', () => {
    expect(renderToStaticMarkup(<EstimatesClient readout={FIXTURE_READOUT} points={FIXTURE_POINTS} />)).toContain('estimates-scatter');
    expect(renderToStaticMarkup(<EstimatesClient readout={FIXTURE_EMPTY_READOUT} points={[]} />)).not.toContain('estimates-details');
  });
});
