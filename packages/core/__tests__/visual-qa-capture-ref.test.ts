/**
 * The ref the visual auditor captures (docs/design/visual-qa-auditor.md, "Page
 * source" → "Which ref is captured"). It must be the base a task PR of the same
 * mission takes, so every case is checked against resolveTaskPrBase itself.
 * Illustrative branch names only.
 */
import { describe, expect, it } from 'bun:test';
import { resolveTaskPrBase } from '../mission-integration';
import { captureRefMatch, normalizeCaptureRef, resolveVisualQaCaptureRef } from '../visual-qa-capture-ref';

const TRUNK = 'dev';
const MISSION_BRANCH = { workingBranch: 'mission/settings-abcd1234', integrationBranchEnabled: true };
const DIRECT = { workingBranch: 'mission/settings-abcd1234', integrationBranchEnabled: false };

/** What a plain builder task of the mission is told its PR base is. */
const taskPrBase = (mission: typeof MISSION_BRANCH | null, integrationBaseMissing = false) =>
  resolveTaskPrBase({
    mission,
    task: { title: 'feat: a thing', taskClass: 'work', context: {} },
    head: 'buildd/11111111-a-thing',
    fallbacks: [TRUNK],
    integrationBaseMissing,
  }).base;

describe('resolveVisualQaCaptureRef', () => {
  it('mission-branch with an integration base: the integration branch, as resolveTaskPrBase says', () => {
    const r = resolveVisualQaCaptureRef({ mission: MISSION_BRANCH, trunk: TRUNK });
    expect(r).toEqual({ ref: 'mission/settings-abcd1234', source: 'mission_integration', integrationBase: 'mission/settings-abcd1234' });
    expect(r.ref).toBe(taskPrBase(MISSION_BRANCH));
  });

  it('mission-branch whose branch vanished: trunk, sourced as integration_missing', () => {
    const r = resolveVisualQaCaptureRef({ mission: MISSION_BRANCH, trunk: TRUNK, integrationBaseMissing: true });
    expect(r).toEqual({ ref: TRUNK, source: 'integration_missing', integrationBase: 'mission/settings-abcd1234' });
    expect(r.ref).toBe(taskPrBase(MISSION_BRANCH, true));
  });

  it('direct strategy: trunk', () => {
    const r = resolveVisualQaCaptureRef({ mission: DIRECT, trunk: TRUNK });
    expect(r).toEqual({ ref: TRUNK, source: 'trunk', integrationBase: null });
    expect(r.ref).toBe(taskPrBase(DIRECT));
  });

  it('no mission: trunk', () => {
    const r = resolveVisualQaCaptureRef({ mission: null, trunk: TRUNK });
    expect(r).toEqual({ ref: TRUNK, source: 'trunk', integrationBase: null });
    expect(r.ref).toBe(taskPrBase(null));
  });

  it('no trunk known and no integration base: null, never a guess', () => {
    expect(resolveVisualQaCaptureRef({ mission: null, trunk: null }).ref).toBeNull();
  });
});

describe('normalizeCaptureRef', () => {
  it('strips origin/ and refs/heads/, and drops a commit sha', () => {
    expect(normalizeCaptureRef('origin/dev')).toBe('dev');
    expect(normalizeCaptureRef('refs/heads/mission/x-1')).toBe('mission/x-1');
    expect(normalizeCaptureRef(' dev ')).toBe('dev');
    expect(normalizeCaptureRef('0123abcd')).toBeNull();
    expect(normalizeCaptureRef('')).toBeNull();
    expect(normalizeCaptureRef(undefined)).toBeNull();
  });
});

describe('captureRefMatch', () => {
  const expected = 'mission/settings-abcd1234';
  it('match, mismatch, and unknown for an unrecorded ref, a sha, or no expected ref', () => {
    expect(captureRefMatch({ ref: 'origin/mission/settings-abcd1234' }, expected)).toBe('match');
    expect(captureRefMatch({ ref: 'dev' }, expected)).toBe('mismatch');
    expect(captureRefMatch({}, expected)).toBe('unknown');
    expect(captureRefMatch({ ref: 'deadbeefcafe' }, expected)).toBe('unknown');
    expect(captureRefMatch({ ref: 'dev' }, null)).toBe('unknown');
  });

  it('a trunk shot the server sourced as integration_missing is never judged wrong-ref', () => {
    expect(captureRefMatch({ ref: 'dev', refSource: 'integration_missing' }, expected)).toBe('unknown');
  });
});
