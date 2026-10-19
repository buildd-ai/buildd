import { describe, it, expect } from 'bun:test';
import { isViewersPersonalRunner } from './runner-ownership';

describe('isViewersPersonalRunner', () => {
  it('is true for a personal key the viewer created', () => {
    expect(isViewersPersonalRunner({ createdByUserId: 'u1' }, 'u1')).toBe(true);
  });
  it('is false for a managed key the viewer created', () => {
    expect(isViewersPersonalRunner({ managedRunner: true, createdByUserId: 'u1' }, 'u1')).toBe(false);
  });
  it('is false for a team-host key the viewer created', () => {
    expect(isViewersPersonalRunner({ hostRunner: true, createdByUserId: 'u1' }, 'u1')).toBe(false);
  });
  it('is false for another member\'s personal key', () => {
    expect(isViewersPersonalRunner({ createdByUserId: 'u2' }, 'u1')).toBe(false);
  });
  it('is false with no viewer or no account', () => {
    expect(isViewersPersonalRunner({ createdByUserId: 'u1' }, null)).toBe(false);
    expect(isViewersPersonalRunner(null, 'u1')).toBe(false);
  });
});
