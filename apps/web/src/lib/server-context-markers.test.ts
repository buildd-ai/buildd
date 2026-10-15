import { describe, it, expect } from 'bun:test';
import { specRepairStamp, withoutMissionVerificationMarkers } from './server-context-markers';

describe('outcome-spec markers are the server\'s to write', () => {
  it('drops a caller\'s finalVerification and specRepair, keeping everything else', () => {
    const ctx = { finalVerification: { missionId: 'm' }, specRepair: { missionId: 'm' }, baseBranch: 'mission/x' };
    expect(withoutMissionVerificationMarkers(ctx)).toEqual({ baseBranch: 'mission/x' });
  });

  it('passes a context without markers through unchanged', () => {
    const ctx = { baseBranch: 'mission/x' };
    expect(withoutMissionVerificationMarkers(ctx)).toBe(ctx);
    expect(withoutMissionVerificationMarkers(null)).toBeNull();
  });

  it('stamps specRepair only for a filing by the same mission\'s final verification task', () => {
    const fv = { missionId: 'm', context: { finalVerification: { missionId: 'm' } } };
    expect(specRepairStamp({ requested: { criterionId: 'R-3' }, missionId: 'm', filerTaskId: 't-fv', filerTask: fv }))
      .toEqual({ missionId: 'm', criterionId: 'R-3', filedBy: 't-fv' });
  });

  it('refuses a builder, a person, another mission\'s verifier, and a forged marker on the filer', () => {
    const builder = { missionId: 'm', context: {} };
    expect(specRepairStamp({ requested: {}, missionId: 'm', filerTaskId: 't-b', filerTask: builder })).toBeNull();
    expect(specRepairStamp({ requested: {}, missionId: 'm', filerTaskId: null, filerTask: null })).toBeNull();
    const other = { missionId: 'other', context: { finalVerification: { missionId: 'other' } } };
    expect(specRepairStamp({ requested: {}, missionId: 'm', filerTaskId: 't-o', filerTask: other })).toBeNull();
    const mismatched = { missionId: 'm', context: { finalVerification: { missionId: 'other' } } };
    expect(specRepairStamp({ requested: {}, missionId: 'm', filerTaskId: 't-x', filerTask: mismatched })).toBeNull();
  });
});
