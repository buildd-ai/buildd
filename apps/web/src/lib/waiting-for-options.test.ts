import { describe, expect, it } from 'bun:test';
import { waitingForOptionLabels } from './waiting-for-options';

describe('waitingForOptionLabels', () => {
  it('reads labels from the option objects the runner writes today', () => {
    expect(waitingForOptionLabels([
      { label: 'Round each line', consequence: 'The total matches the card charge.', recommended: true },
      { label: 'Round the total', description: 'Matches the ledger.' },
    ])).toEqual(['Round each line', 'Round the total']);
  });

  it('still reads the plain strings older rows carry', () => {
    expect(waitingForOptionLabels(['Yes', 'No'])).toEqual(['Yes', 'No']);
  });

  it('drops anything that is not a usable label instead of throwing', () => {
    expect(waitingForOptionLabels(['  ', { label: '' }, { label: 3 }, null, 7, 'Ok'])).toEqual(['Ok']);
    expect(waitingForOptionLabels(undefined)).toEqual([]);
    expect(waitingForOptionLabels({ label: 'not an array' })).toEqual([]);
  });
});
