import { describe, it, expect } from 'bun:test';
import { queueRowAction, startAnywayPhase, countsAsExecuting } from '../start-anyway';

// Health › Queue R-20 / AC-13 (spec 4bc3e70e r7): the one action a row offers, the
// same one the task page and sheet offer.
describe('queueRowAction', () => {
  it('Declared rows offer Start anyway', () => {
    expect(queueRowAction('declared')).toEqual({ action: 'start_anyway', label: 'Start anyway' });
  });
  it('Limit rows keep their Force start', () => {
    expect(queueRowAction('limit')).toEqual({ action: 'force_start', label: 'Force start' });
  });
  it('Lane rows admit assessment only and grant no ownership', () => {
    expect(queueRowAction('lane')).toEqual({ action: 'start_anyway', label: 'Start anyway', grantsOwnership: false });
  });
  it('a real restriction offers its own fix: never a dead end', () => {
    expect(queueRowAction('restriction')).toEqual({ action: 'fix', label: 'Fix' });
  });
  it('a request is not rendered as running until claimed, and a parked task holds no executing slot', () => {
    expect(startAnywayPhase({ intent: { id: 'f' }, claimed: false, parked: false, executing: false }).phase).toBe('requested');
    expect(countsAsExecuting({ phase: 'blocked' })).toBe(false);
    expect(countsAsExecuting({ phase: 'requested' })).toBe(false);
  });
});
