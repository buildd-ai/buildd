import { describe, expect, it } from 'bun:test';
import { formatWaiverBody, parseWaiverBody } from './surface-audit-waiver-body';

describe('waiver body', () => {
  it('round-trips reason and policy', () => {
    expect(parseWaiverBody(formatWaiverBody('  Copy-only change ', 'ask'))).toEqual({ reason: 'Copy-only change', policy: 'ask' });
  });
  it('a note from before the policy line reads as policy unknown', () => {
    expect(parseWaiverBody('Docs only')).toEqual({ reason: 'Docs only', policy: null });
    expect(parseWaiverBody(null)).toEqual({ reason: '', policy: null });
  });
  it('a reason that mentions policy mid-text is left alone', () => {
    expect(parseWaiverBody('Policy: ask is fine here, really')).toEqual({ reason: 'Policy: ask is fine here, really', policy: null });
  });
});
