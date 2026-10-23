import { describe, it, expect } from 'bun:test';
import { RELEASE_CANDIDATE_CONTEXT_KEYS, specRepairStamp, withoutMissionVerificationMarkers } from './server-context-markers';
import { RELEASE_CANDIDATE_FIX_KEY } from './release-candidate-ci';
import { RELEASE_CANDIDATE_AMEND_PR_KEY } from './release/candidate-amend';

describe('outcome-spec markers are the server\'s to write', () => {
  it('drops a caller\'s finalVerification and specRepair, keeping everything else', () => {
    const ctx = { finalVerification: { missionId: 'm' }, specRepair: { missionId: 'm' }, baseBranch: 'mission/x' };
    expect(withoutMissionVerificationMarkers(ctx)).toEqual({ baseBranch: 'mission/x' });
  });

  it('drops a caller\'s release-candidate keys too', () => {
    const ctx = { releaseCandidateFix: { prNumber: 1, version: '1.0.0', sourceBranch: 'dev' }, releaseCandidateAmendPr: 2, baseBranch: 'dev' };
    expect(withoutMissionVerificationMarkers(ctx)).toEqual({ baseBranch: 'dev' });
  });

  it('lists the same key names the release flow writes', () => {
    expect([...RELEASE_CANDIDATE_CONTEXT_KEYS].sort()).toEqual([RELEASE_CANDIDATE_AMEND_PR_KEY, RELEASE_CANDIDATE_FIX_KEY].sort());
  });

  it('passes a context without markers through unchanged', () => {
    const ctx = { baseBranch: 'mission/x' };
    expect(withoutMissionVerificationMarkers(ctx)).toBe(ctx);
    expect(withoutMissionVerificationMarkers(null)).toBeNull();
  });

  it('stamps specRepair only for a filing by the same mission\'s final verification task, with its spec and criterion', () => {
    const fv = { missionId: 'm', context: { finalVerification: { missionId: 'm', specId: 's-1' } } };
    expect(specRepairStamp({ requested: { criterionId: 'R-3' }, missionId: 'm', filerTaskId: 't-fv', filerTask: fv }))
      .toEqual({ ok: true, marker: { missionId: 'm', specId: 's-1', criterionId: 'R-3', filedBy: 't-fv' } });
    expect(specRepairStamp({ requested: { specId: 's-1', criterionId: 'AC-2' }, missionId: 'm', filerTaskId: 't-fv', filerTask: fv }))
      .toEqual({ ok: true, marker: { missionId: 'm', specId: 's-1', criterionId: 'AC-2', filedBy: 't-fv' } });
  });

  it('refuses a repair from the final verification that names no criterion, or another spec', () => {
    const fv = { missionId: 'm', context: { finalVerification: { missionId: 'm', specId: 's-1' } } };
    for (const requested of [undefined, {}, { criterionId: 'D-4' }, { criterionId: 3 }]) {
      const r = specRepairStamp({ requested, missionId: 'm', filerTaskId: 't-fv', filerTask: fv });
      expect(r?.ok).toBe(false);
      if (r && !r.ok) expect(r.reason).toContain('criterionId');
    }
    const other = specRepairStamp({ requested: { specId: 's-2', criterionId: 'R-1' }, missionId: 'm', filerTaskId: 't-fv', filerTask: fv });
    expect(other).toEqual({ ok: false, reason: expect.stringContaining('s-1') });
  });

  it('takes the requested spec id when the verification predates recording one', () => {
    const old = { missionId: 'm', context: { finalVerification: { missionId: 'm' } } };
    expect(specRepairStamp({ requested: { criterionId: 'R-3' }, missionId: 'm', filerTaskId: 't-fv', filerTask: old }))
      .toEqual({ ok: true, marker: { missionId: 'm', criterionId: 'R-3', filedBy: 't-fv' } });
    expect(specRepairStamp({ requested: { specId: 's-9', criterionId: 'R-3' }, missionId: 'm', filerTaskId: 't-fv', filerTask: old }))
      .toEqual({ ok: true, marker: { missionId: 'm', specId: 's-9', criterionId: 'R-3', filedBy: 't-fv' } });
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
