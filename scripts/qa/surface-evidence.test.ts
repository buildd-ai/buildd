import { describe, expect, it } from 'bun:test';
import { runUiActionStateCheck } from '../../packages/core/ui-verification';
import { composeSurfaceEvidence, parseSurfaceFacts, surfaceCollector, type RawSurface, type SurfaceContext } from './surface-evidence';

const SHA = 'a'.repeat(40);
const ctx = (over: Partial<SurfaceContext> = {}): SurfaceContext => ({
  commitSha: SHA, route: '/app/tasks/:id?tab=pr', scenarioId: 'closed-pr', viewport: 'mobile',
  captureId: 'app-tasks-x--closed-pr@2026-10-22T00:00:00.000Z', capturedAt: '2026-10-22T00:00:00.000Z',
  snapshotRef: 'surfaces/app-tasks-x--closed-pr.json', screenshot: true,
  facts: { factVersion: 'seed-closed-pr@3', scenarios: { 'closed-pr': { prState: 'closed', replacementState: 'none' } } },
  collector: 'visual_auditor', ...over,
});
const raw = (over: Partial<RawSurface> = {}): RawSurface => ({
  found: 1,
  blocks: [
    { id: 'status', role: 'status', text: '  Pull request\n closed ', collapsed: false, nested: false },
    { id: 'why', role: 'body', text: 'Closed without merging.', collapsed: true, nested: false },
  ],
  actions: [{ id: 'open', operation: 'merge_pr', prominence: 'primary', inMenu: false, label: 'Merge', enabled: true, collapsed: false }],
  ...over,
});
const ok = (r: ReturnType<typeof composeSurfaceEvidence>) => { if (!r.ok) throw new Error(r.reason); return r; };

describe('surface evidence from a capture', () => {
  it('R-11: route, scenario, SHA and capture identity, ordered composed text, semantic operations, disclosure and prominence', () => {
    const { evidence, notes } = ok(composeSurfaceEvidence(raw(), ctx()));
    expect(evidence.subject).toEqual({ commitSha: SHA, route: '/app/tasks/:id', scenarioId: 'closed-pr', viewport: 'mobile' });
    expect(evidence.capture).toEqual({ captureId: ctx().captureId, capturedAt: ctx().capturedAt, snapshotRef: ctx().snapshotRef });
    expect(evidence.visible.blocks).toEqual([
      { id: 'status', role: 'status', text: 'Pull request closed', order: 0, disclosure: 'visible' },
      { id: 'why', role: 'body', text: 'Closed without merging.', order: 1, disclosure: 'collapsed' },
    ]);
    expect(evidence.visible.actions).toEqual([{ id: 'open', label: 'Merge', operation: 'merge_pr', enabled: true, prominence: 'primary', disclosure: 'visible' }]);
    expect(evidence.coverage).toEqual({ renderedText: 'complete', actions: 'complete', runtimeState: 'complete', screenshot: 'complete' });
    expect(notes).toEqual([]);
    // The deterministic check sees the contradiction from the declared operation and the supplied facts.
    expect(runUiActionStateCheck(evidence).verdict).toBe('fail');
  });

  it('R-12: an operation is the declared one, never the label: an undeclared button is other, and the check says unsupported', () => {
    const declared = ok(composeSurfaceEvidence(raw({ actions: [{ id: 'c', operation: 'confirm_replacement', prominence: 'primary', inMenu: false, label: 'Merge replacement', enabled: true, collapsed: false }] }), ctx()));
    expect(declared.evidence.visible.actions[0]!.operation).toBe('confirm_replacement');
    expect(runUiActionStateCheck(declared.evidence).verdict).not.toBe('fail');

    const undeclared = ok(composeSurfaceEvidence(raw({ actions: [{ id: 'm', operation: null, prominence: 'primary', inMenu: false, label: 'Merge', enabled: true, collapsed: false }] }), ctx()));
    expect(undeclared.evidence.visible.actions[0]!.operation).toBe('other');
    expect(undeclared.notes).toEqual(['action 0: no declared data-verify-action, recorded as other']);
    expect(runUiActionStateCheck(undeclared.evidence).verdict).toBe('unsupported');
  });

  it('R-11: runtime facts come only from the supplied, versioned set; a scenario without them records none and is inconclusive', () => {
    const { evidence } = ok(composeSurfaceEvidence(raw(), ctx()));
    expect(evidence.facts).toEqual({ prState: 'closed', replacementState: 'none' });
    expect(evidence.provenance).toEqual({ collector: 'visual_auditor', collectorVersion: 'buildd-qa-capture@1', reportedVia: 'task_token', factVersion: 'seed-closed-pr@3' });

    const none = ok(composeSurfaceEvidence(raw(), ctx({ scenarioId: 'open-pr' })));
    expect(none.evidence.facts).toEqual({});
    expect(none.evidence.coverage.runtimeState).toBe('absent');
    expect(none.evidence.provenance.factVersion).toBe('none');
    expect(none.notes).toContain('no runtime facts supplied for scenario open-pr');
    expect(runUiActionStateCheck(none.evidence).verdict).toBe('inconclusive');

    // A new fact version is a different capture, so an earlier result cannot stand for it.
    const bumped = ok(composeSurfaceEvidence(raw(), ctx({ facts: { ...ctx().facts!, factVersion: 'seed-closed-pr@4' } })));
    expect(bumped.evidence).not.toEqual(ok(composeSurfaceEvidence(raw(), ctx())).evidence);
  });

  it('R-14: pixels stay a separate capability: the evidence says whether a shot exists, never what it shows', () => {
    const { evidence } = ok(composeSurfaceEvidence(raw(), ctx({ screenshot: false })));
    expect(evidence.coverage.screenshot).toBe('absent');
    expect(evidence.capture.screenshotRef).toBeUndefined();
  });

  it('R-16: what could not be captured completely is partial and listed, never dropped quietly', () => {
    const many = Array.from({ length: 34 }, (_, i) => ({ id: `b${i}`, role: 'body', text: `line ${i}`, collapsed: false, nested: false }));
    const r = ok(composeSurfaceEvidence(raw({
      blocks: [{ id: 'x', role: 'banner', text: 'Unknown role', collapsed: false, nested: false }, { id: 'long', role: 'body', text: 'w'.repeat(1200), collapsed: false, nested: true }, ...many],
      actions: [{ id: 'm', operation: 'merge_pr', prominence: null, inMenu: false, label: '', enabled: false, collapsed: false },
        { id: 'k', operation: 'skip_visual_review', prominence: null, inMenu: true, label: 'Skip', enabled: true, collapsed: true }],
    }), ctx()));
    expect(r.evidence.coverage.renderedText).toBe('partial');
    expect(r.evidence.coverage.actions).toBe('partial');
    expect(r.evidence.visible.blocks).toHaveLength(32);
    expect(r.evidence.visible.blocks[0]!.text).toHaveLength(1000);
    expect(r.evidence.visible.actions.map((a) => [a.label, a.prominence, a.disclosure])).toEqual([['unlabeled', 'secondary', 'visible'], ['Skip', 'menu', 'collapsed']]);
    expect(r.notes).toEqual(expect.arrayContaining([
      expect.stringContaining('"banner" is not one of'), expect.stringContaining('contains another block'), expect.stringContaining('cut to 1000'),
      expect.stringContaining('more than 32 blocks'), 'action 0: no data-verify-prominence', 'action 0: no visible or accessible label',
    ]));
  });

  it('no capture without a commit, a rendered surface, exactly one of it, or evidence that passes screening', () => {
    expect(composeSurfaceEvidence(raw(), ctx({ commitSha: undefined }))).toMatchObject({ ok: false, reason: expect.stringContaining('capture_sha_unset') });
    expect(composeSurfaceEvidence(raw(), ctx({ commitSha: 'abc' }))).toMatchObject({ ok: false });
    expect(composeSurfaceEvidence(raw({ found: 0 }), ctx())).toEqual({ ok: false, reason: 'surface_not_rendered' });
    expect(composeSurfaceEvidence(raw({ found: 2 }), ctx())).toMatchObject({ ok: false, reason: expect.stringContaining('surface_ambiguous') });
    const leaked = raw({ blocks: [{ id: 'k', role: 'body', text: `token ghp_${'x'.repeat(20)}`, collapsed: false, nested: false }] });
    expect(composeSurfaceEvidence(leaked, ctx())).toEqual({ ok: false, reason: 'sensitive_surface_evidence' });
    expect(composeSurfaceEvidence(raw(), ctx({ facts: { factVersion: 'v', scenarios: { 'closed-pr': { prState: 'reopened' } as never } } }))).toEqual({ ok: false, reason: 'invalid_surface_evidence' });
  });

  it('QA_SURFACE_FACTS and QA_SURFACE_COLLECTOR are strict, and the collector defaults to the least authority', () => {
    expect(parseSurfaceFacts(undefined, () => '')).toBeNull();
    expect(parseSurfaceFacts('{"factVersion":"v1","scenarios":{"closed-pr":{"prState":"closed"}}}', () => '')).toEqual({ factVersion: 'v1', scenarios: { 'closed-pr': { prState: 'closed' } } });
    expect(parseSurfaceFacts('facts.json', () => '{"factVersion":"v2","scenarios":{}}')).toEqual({ factVersion: 'v2', scenarios: {} });
    expect(() => parseSurfaceFacts('{"scenarios":{}}', () => '')).toThrow(/factVersion/);
    expect(() => parseSurfaceFacts('{"factVersion":"v","scenarios":{"Bad Id":{}}}', () => '')).toThrow(/scenario id/);
    expect(surfaceCollector(undefined)).toBe('agent');
    expect(surfaceCollector('visual_auditor')).toBe('visual_auditor');
    expect(() => surfaceCollector('builder')).toThrow();
  });
});
