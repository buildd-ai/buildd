import { describe, it, expect } from 'bun:test';
import {
  BYPASS_SUBJECT_GATE_KEY,
  SUBJECT_BINDING_SOURCES,
  SUBJECT_DEAD_RESOLUTION,
  isBindingSubjectSource,
  isSubjectDead,
} from './subject-gate-contract';

describe('subject-gate contract — binding sources', () => {
  const sources = [...SUBJECT_BINDING_SOURCES] as string[];

  it('binds on system anchors (retry/watcher machinery asserted the subject)', () => {
    expect(sources).toContain('system');
    expect(isBindingSubjectSource('system')).toBe(true);
  });

  it('binds on context anchors (structured request context)', () => {
    expect(sources).toContain('context');
    expect(isBindingSubjectSource('context')).toBe(true);
  });

  it('does NOT bind on text anchors — a prose mention is not an identity', () => {
    expect(sources).not.toContain('text');
    expect(isBindingSubjectSource('text')).toBe(false);
  });

  it('does NOT bind on url anchors scraped from the description', () => {
    expect(sources).not.toContain('url');
    expect(isBindingSubjectSource('url')).toBe(false);
  });

  it('does NOT bind on backfill anchors (retro-stamped, never asserted)', () => {
    expect(sources).not.toContain('backfill');
    expect(isBindingSubjectSource('backfill')).toBe(false);
  });

  it('treats a missing/unknown source as advisory (fail open)', () => {
    expect(isBindingSubjectSource(null)).toBe(false);
    expect(isBindingSubjectSource(undefined)).toBe(false);
    expect(isBindingSubjectSource('')).toBe(false);
    expect(isBindingSubjectSource('something-new')).toBe(false);
  });

  it('only system and context bind — nothing else', () => {
    expect(sources.slice().sort()).toEqual(['context', 'system']);
  });

  it('exposes stable string constants the SQL gate and /start route share', () => {
    expect(SUBJECT_DEAD_RESOLUTION).toBe('reconciled');
    expect(BYPASS_SUBJECT_GATE_KEY).toBe('bypassSubjectGate');
  });
});

describe('isSubjectDead', () => {
  it('REGRESSION (task aeb80f): a text/derived anchor + reconciled stays claimable', () => {
    // Real prod shape: description merely mentioned "PR #1789" as background.
    // The sweep stamped reconciled when #1789 closed, and the task became
    // permanently unclaimable while still rendering as QUEUED.
    expect(
      isSubjectDead({
        subjectKind: 'pull_request',
        subjectPrNumber: 1789,
        subjectResolution: 'reconciled',
        subjectAnchor: {
          version: 1,
          kind: 'pull_request',
          prNumber: 1789,
          source: 'text',
          confidence: 'derived',
        } as any,
      }),
    ).toBe(false);
  });

  it('a url/derived anchor + reconciled stays claimable', () => {
    expect(
      isSubjectDead({
        subjectKind: 'pull_request',
        subjectPrNumber: 1789,
        subjectResolution: 'reconciled',
        subjectAnchor: { source: 'url' },
      }),
    ).toBe(false);
  });

  it('KEEPS BLOCKING the legitimate case: system/exact anchor + reconciled (CI retry for a closed PR)', () => {
    expect(
      isSubjectDead({
        subjectKind: 'pull_request',
        subjectPrNumber: 1789,
        subjectResolution: 'reconciled',
        subjectAnchor: { source: 'system' },
      }),
    ).toBe(true);
  });

  it('blocks a context-sourced anchor + reconciled', () => {
    expect(
      isSubjectDead({
        subjectKind: 'pull_request',
        subjectPrNumber: 42,
        subjectResolution: 'reconciled',
        subjectAnchor: { source: 'context' },
      }),
    ).toBe(true);
  });

  it('never blocks when the anchor column is missing (undefined source reads as advisory)', () => {
    // Guards the "missing column reads as undefined" class of bug: a consumer
    // that forgets to select subject_anchor must fail OPEN, not re-open the hole
    // by treating undefined as binding.
    expect(
      isSubjectDead({
        subjectKind: 'pull_request',
        subjectPrNumber: 1789,
        subjectResolution: 'reconciled',
      }),
    ).toBe(false);
  });

  it('never blocks tasks with no subject anchor at all (backwards compat)', () => {
    expect(isSubjectDead({})).toBe(false);
    expect(isSubjectDead({ subjectKind: null, subjectPrNumber: null, subjectResolution: null })).toBe(false);
  });

  it('never blocks non-pull_request subjects, even if marked reconciled', () => {
    for (const kind of ['error', 'mission', 'branch']) {
      expect(
        isSubjectDead({
          subjectKind: kind,
          subjectResolution: 'reconciled',
          subjectAnchor: { source: 'system' },
        }),
      ).toBe(false);
    }
  });

  it('never blocks a pull_request subject with no PR number', () => {
    expect(
      isSubjectDead({
        subjectKind: 'pull_request',
        subjectPrNumber: null,
        subjectResolution: 'reconciled',
        subjectAnchor: { source: 'system' },
      }),
    ).toBe(false);
  });

  it('never blocks on non-reconciled resolutions', () => {
    for (const resolution of [null, 'attached', 'superseded', 'filed_anyway']) {
      expect(
        isSubjectDead({
          subjectKind: 'pull_request',
          subjectPrNumber: 42,
          subjectResolution: resolution,
          subjectAnchor: { source: 'system' },
        }),
      ).toBe(false);
    }
  });

  it('honors the force-start bypass flag (boolean or string "true")', () => {
    const dead = {
      subjectKind: 'pull_request',
      subjectPrNumber: 42,
      subjectResolution: 'reconciled',
      subjectAnchor: { source: 'system' },
    };
    expect(isSubjectDead(dead)).toBe(true);
    expect(isSubjectDead({ ...dead, context: { bypassSubjectGate: true } })).toBe(false);
    expect(isSubjectDead({ ...dead, context: { bypassSubjectGate: 'true' } })).toBe(false);
    // An unrelated bypass must NOT open this gate.
    expect(isSubjectDead({ ...dead, context: { bypassDepsGate: true } })).toBe(true);
  });
});
