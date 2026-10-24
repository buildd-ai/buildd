import { describe, expect, it } from 'bun:test';
import { parseSurfaceEvidence, parseUiCopyFeatures, uiCopyFeaturesFromSurface, uiCopyFindings, type SurfaceEvidence } from './ui-verification';

const capture = (over: Partial<SurfaceEvidence> = {}): SurfaceEvidence => {
  const r = parseSurfaceEvidence({
    schemaVersion: 1,
    subject: { commitSha: 'a'.repeat(40), route: '/app/missions/:id', scenarioId: 'closed-pr', viewport: 'mobile' },
    capture: { captureId: 'closed-pr@2026-10-22T00:00:00.000Z', capturedAt: '2026-10-22T00:00:00.000Z', snapshotRef: 'surfaces/closed-pr.json' },
    visible: {
      blocks: [
        { id: 'head', role: 'heading', text: 'PR #40 closed without merging', order: 0, disclosure: 'visible' },
        { id: 'went', role: 'consequence', text: 'PR #40 is likely superseded by acme/app#41 (merged by the same task).', order: 1, disclosure: 'visible' },
      ],
      actions: [{ id: 'confirm', label: 'Confirm #41', operation: 'confirm_replacement', enabled: true, prominence: 'primary', disclosure: 'visible' }],
    },
    facts: { prState: 'closed', replacementState: 'candidate' },
    provenance: { collector: 'visual_auditor', collectorVersion: 'buildd-qa-capture@1', reportedVia: 'task_token', factVersion: 'seed-closed-pr@3' },
    coverage: { renderedText: 'complete', actions: 'complete', runtimeState: 'complete', screenshot: 'absent' },
    ...over,
  });
  if (!r.ok) throw new Error(r.message);
  return r.features;
};

describe('ui_copy features from a capture', () => {
  it('R-13: a captured consequence reaches the features as material, and the findings guard keeps it when a model calls it dispensable', () => {
    const f = uiCopyFeaturesFromSurface(capture());
    expect(f.segments.map((s) => [s.id, s.role])).toEqual([['head', 'heading'], ['went', 'consequence']]);
    expect(uiCopyFindings({ findings: [{ kind: 'repetition', segmentIds: ['went', 'head'] }, { kind: 'process_narration', segmentIds: ['went'] }] }, f))
      .toEqual([{ kind: 'repetition', segmentIds: ['head'] }]);
  });

  it('carries the capture\'s runtime facts with their version and the criterion being judged, and both parse strictly', () => {
    const f = uiCopyFeaturesFromSurface(capture(), undefined, { id: 'R-13', text: 'Copy preserves material consequences.' });
    expect(f.state).toEqual({ factVersion: 'seed-closed-pr@3', facts: { prState: 'closed', replacementState: 'candidate' } });
    expect(f.criterion).toEqual({ id: 'R-13', text: 'Copy preserves material consequences.' });
    expect(parseUiCopyFeatures(f)).toEqual({ ok: true, features: f });
    expect(parseUiCopyFeatures({ ...f, state: { ...f.state, extra: 1 } }).ok).toBe(false);
    expect(parseUiCopyFeatures({ ...f, state: { factVersion: 'v', facts: { prState: 'reopened' } } }).ok).toBe(false);
    expect(parseUiCopyFeatures({ ...f, criterion: { id: 'R-13', text: 'x'.repeat(2001) } }).ok).toBe(false);
    expect(parseUiCopyFeatures({ ...f, criterion: { id: 'anything', text: 'x' } }).ok).toBe(false);
  });

  it('a capture without supplied facts carries no state, and features without the new fields stay valid', () => {
    const f = uiCopyFeaturesFromSurface(capture({ facts: {}, provenance: { collector: 'visual_auditor', collectorVersion: 'buildd-qa-capture@1', reportedVia: 'task_token', factVersion: 'none' } }));
    expect('state' in f).toBe(false);
    expect('criterion' in f).toBe(false);
    expect(parseUiCopyFeatures({ profile: f.profile, segments: f.segments, actions: f.actions }).ok).toBe(true);
  });
});
