import { describe, expect, it } from 'bun:test';
import { resolveVisualReviewPolicy, legacyMissionException } from './visual-review-policy';

describe('legacyMissionException', () => {
  it('maps autoSurfaceAudit true / null / undefined to inherit', () => {
    expect(legacyMissionException(true)).toBeNull();
    expect(legacyMissionException(null)).toBeNull();
    expect(legacyMissionException(undefined)).toBeNull();
  });
  it('maps autoSurfaceAudit false to an off exception', () => {
    expect(legacyMissionException(false)).toBe('off');
  });
});

describe('resolveVisualReviewPolicy', () => {
  it('defaults to automatic with origin default', () => {
    expect(resolveVisualReviewPolicy({})).toMatchObject({ mode: 'automatic', origin: 'default', waiverAllowed: true, locked: false });
  });
  it('team default applies when the workspace inherits', () => {
    expect(resolveVisualReviewPolicy({ team: 'ask' })).toMatchObject({ mode: 'ask', origin: 'team' });
  });
  it('workspace override beats the team default', () => {
    expect(resolveVisualReviewPolicy({ team: 'ask', workspace: 'off' })).toMatchObject({ mode: 'off', origin: 'workspace' });
  });
  it('a mission exception beats the workspace', () => {
    expect(resolveVisualReviewPolicy({ workspace: 'automatic', mission: { policy: 'ask' } })).toMatchObject({ mode: 'ask', origin: 'mission' });
  });
  it('legacy autoSurfaceAudit=false is an off exception', () => {
    expect(resolveVisualReviewPolicy({ workspace: 'automatic', mission: { autoSurfaceAudit: false } })).toMatchObject({ mode: 'off', origin: 'mission' });
  });
  it('legacy autoSurfaceAudit=true inherits', () => {
    expect(resolveVisualReviewPolicy({ workspace: 'ask', mission: { autoSurfaceAudit: true } })).toMatchObject({ mode: 'ask', origin: 'workspace' });
  });
  it('an explicit mission policy wins over the legacy flag', () => {
    expect(resolveVisualReviewPolicy({ mission: { policy: 'ask', autoSurfaceAudit: false } })).toMatchObject({ mode: 'ask', origin: 'mission' });
  });
  it('strict forbids skip/waive and ignores any mission exception', () => {
    const r = resolveVisualReviewPolicy({ workspace: 'strict', mission: { policy: 'off', autoSurfaceAudit: false } });
    expect(r).toMatchObject({ mode: 'strict', origin: 'workspace', waiverAllowed: false, locked: true, exceptionIgnored: true });
  });
  it('strict inherited from the team is locked too', () => {
    expect(resolveVisualReviewPolicy({ team: 'strict', mission: { policy: 'off' } })).toMatchObject({ mode: 'strict', origin: 'team', locked: true });
  });
  it('a workspace can loosen a strict team default', () => {
    expect(resolveVisualReviewPolicy({ team: 'strict', workspace: 'automatic' })).toMatchObject({ mode: 'automatic', origin: 'workspace', locked: false });
  });
  it('off allows no waiver need but waiverAllowed stays true (nothing to skip)', () => {
    expect(resolveVisualReviewPolicy({ workspace: 'off' }).waiverAllowed).toBe(true);
  });
  it('reports the inherited value under a mission exception', () => {
    expect(resolveVisualReviewPolicy({ team: 'ask', mission: { autoSurfaceAudit: false } }).inherited).toEqual({ mode: 'ask', origin: 'team' });
  });
});
