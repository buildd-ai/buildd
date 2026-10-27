import { describe, expect, it } from 'bun:test';
import { reverifyStateOf } from './mission-reverify-state';

describe('reverifyStateOf', () => {
  it('no open run reads idle', () => expect(reverifyStateOf([])).toBe('idle'));
  it('a pending or assigned run reads queued', () => {
    expect(reverifyStateOf(['pending'])).toBe('queued');
    expect(reverifyStateOf(['assigned'])).toBe('queued');
  });
  it('a run in progress reads running even beside a queued one', () => expect(reverifyStateOf(['pending', 'in_progress'])).toBe('running'));
  it('finished runs read idle', () => expect(reverifyStateOf(['completed', 'failed', 'cancelled'])).toBe('idle'));
});
