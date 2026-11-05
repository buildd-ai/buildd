import { describe, expect, test } from 'bun:test';
import { decideAheadHold } from './ahead-hold';

const pin = { specId: 's', revision: 2, provisional: true };
const spec = (approvedRevision: number | null, headRevision: number) => ({ title: 'Billing', approvedRevision, headRevision });

describe('decideAheadHold', () => {
  test('no pin, or an ordinary pin: nothing to hold', () => {
    expect(decideAheadHold({ pin: null, toMissionBranch: false, spec: null }).hold).toBe(false);
    expect(decideAheadHold({ pin: { specId: 's', revision: 2 }, toMissionBranch: false, spec: spec(2, 2) }).hold).toBe(false);
  });
  test('a mission-branch merge proceeds', () => {
    expect(decideAheadHold({ pin, toMissionBranch: true, spec: spec(null, 2) }).hold).toBe(false);
  });
  test('trunk merge holds until the pinned revision is approved', () => {
    const r = decideAheadHold({ pin, toMissionBranch: false, spec: spec(null, 2) });
    expect(r.hold).toBe(true);
    expect(r.hold && r.reason).toContain('built ahead of approval of Billing rev 2');
  });
  test('pinned revision approved: passes', () => {
    expect(decideAheadHold({ pin, toMissionBranch: false, spec: spec(2, 2) }).hold).toBe(false);
  });
  test('superseded by a newer draft head: holds and says to re-pin to the head', () => {
    const r = decideAheadHold({ pin, toMissionBranch: false, spec: spec(null, 3) });
    expect(r.hold && r.reason).toContain('superseded by revision 3');
  });
  test('superseded by a later approved revision, pin not yet re-pinned: holds until re-pin', () => {
    const r = decideAheadHold({ pin, toMissionBranch: false, spec: spec(3, 3) });
    expect(r.hold && r.reason).toContain('re-pinned');
  });
  test('after the re-pin to the approved revision the pin is not provisional: passes', () => {
    expect(decideAheadHold({ pin: { specId: 's', revision: 3, regradedFrom: { revision: 2 } }, toMissionBranch: false, spec: spec(3, 3) }).hold).toBe(false);
  });
  test('re-pinned to the new draft head: holds on the new revision', () => {
    const r = decideAheadHold({ pin: { ...pin, revision: 3 }, toMissionBranch: false, spec: spec(null, 3) });
    expect(r.hold && r.reason).toContain('rev 3');
  });
  test('spec gone: holds rather than guessing', () => {
    expect(decideAheadHold({ pin, toMissionBranch: false, spec: null }).hold).toBe(true);
  });
});
