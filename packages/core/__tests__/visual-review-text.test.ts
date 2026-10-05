/**
 * The shared visual review text (visual-review-text.ts): the chat's
 * get_visual_review and the MCP get_visual_review action both read it.
 * Illustrative ids and routes only.
 */
import { describe, expect, it } from 'bun:test';
import type { VisualReviewCell, VisualReviewModel, VisualReviewAuditTask } from '@buildd/shared';
import { formatVisualReview, describeVisualPhase, otherVisualEvidence, type VisualEvidenceArtifact } from '../visual-review-text';

const A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const SHOT1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const SHOT2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const FIX = 'cccccccc-0000-4000-8000-000000000001';

function cell(id: string, viewport: 'mobile' | 'desktop', verdict: 'ok' | 'issue' | 'unsure', finding: string, extra: Partial<VisualReviewCell> = {}): VisualReviewCell {
  const entry = {
    round: 2,
    shot: { id, auditTaskId: A2, round: 2, createdAt: '2026-03-10T10:00:00.000Z', src: `/api/artifacts/${id}/download`, qa: { runKey: '', route: '/app/example', viewport, finding, verdict } },
    agentVerdict: verdict,
    finding,
    fixTask: null,
    review: null,
  };
  return {
    key: `/app/example|${viewport}|`,
    route: '/app/example',
    viewport,
    variant: null,
    current: entry,
    history: [entry],
    effectiveVerdict: verdict,
    marker: 'awaiting',
    needsHuman: verdict === 'unsure',
    ...extra,
  };
}

const audits: VisualReviewAuditTask[] = [
  { id: A1, title: '[surface audit] Example', status: 'cancelled', round: 1, createdAt: '2026-03-10T09:00:00.000Z', endedAt: '2026-03-10T09:10:00.000Z', errorType: null, why: null },
  { id: A2, title: '[surface audit] Example (round 2)', status: 'failed', round: 2, createdAt: '2026-03-10T09:30:00.000Z', endedAt: '2026-03-10T09:50:00.000Z', errorType: 'max_turns', why: 'Ran out of turns before the last route.' },
];

function model(over: Partial<VisualReviewModel> = {}): VisualReviewModel {
  const cells = [
    cell(SHOT1, 'mobile', 'unsure', 'Header may overlap.'),
    { ...cell(SHOT2, 'desktop', 'issue', 'Two headings.'), current: { ...cell(SHOT2, 'desktop', 'issue', 'Two headings.').current, fixTask: { id: FIX, title: '[surface fix] x', status: 'in_progress', prUrl: null, prNumber: 12, mergedAt: null, mergedInto: null, origin: 'auditor' as const } } },
  ];
  return {
    missionId: 'mission-1',
    phase: 'needs_you',
    progress: null,
    audit: audits[1],
    audits,
    bootFailure: null,
    roundCapOpen: false,
    needsYou: { reason: 'unsure' },
    cells,
    queue: cells.map(c => c.key),
    summary: { shots: 2, ok: 0, issues: 1, unsure: 1, effectiveOk: 0, effectiveIssues: 1, reviewed: 0, unreviewed: 2, awaitingHuman: 1, confirmed: 0, disputed: 0, waived: 0, rounds: 2, openFixes: 1 },
    fixTasks: [],
    generatedAt: '2026-03-10T11:00:00.000Z',
    ...over,
  };
}

const BASE = 'https://app.example.test';

describe('formatVisualReview for MCP', () => {
  it('lists every audit task with status and why, including cancelled ones', () => {
    const text = formatVisualReview(model(), 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1' });
    expect(text).toContain(`round 1: cancelled, started 2026-03-10 09:00 UTC, ended 2026-03-10 09:10 UTC (task ${A1}): no reason recorded`);
    expect(text).toContain(`round 2: failed, started 2026-03-10 09:30 UTC, ended 2026-03-10 09:50 UTC (task ${A2}): max_turns; Ran out of turns before the last route.`);
    expect(text).toMatch(/Audit tasks \(2\)/);
  });

  it('links each screenshot to its artifact page and download URL', () => {
    const text = formatVisualReview(model(), 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1' });
    expect(text).toContain(`${BASE}/app/artifacts/${SHOT1}`);
    expect(text).toContain(`${BASE}/api/artifacts/${SHOT1}/download`);
    expect(text).toContain(`${BASE}/app/artifacts/${SHOT2}`);
  });

  it('gives per cell: viewport, round, verdict, finding, decision and fix with status', () => {
    const text = formatVisualReview(model(), 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1' });
    expect(text).toMatch(/phone; round 2; agent: unsure; "Header may overlap\."; human: not reviewed, needs review/);
    expect(text).toMatch(new RegExp(`fix: in progress, PR #12 \\(task ${FIX}\\)`));
    expect(text).toContain('1 screen to review.');
  });

  it('round cap: says a decision is needed and never "0 need your review"', () => {
    const m = model({ needsYou: { reason: 'round_cap' }, roundCapOpen: true, cells: [model().cells[1]], summary: { ...model().summary, unsure: 0, awaitingHuman: 0 } });
    const text = formatVisualReview(m, 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1' });
    expect(text).not.toMatch(/\b0 (screens? )?needs? your review/);
    expect(text).toContain('Decision needed: issues remain after 2 rounds (fix or waive).');
  });

  it('question: the closing line carries the prompt', () => {
    const m = model({ needsYou: { reason: 'question', prompt: 'Is the old header intended?' } as never, summary: { ...model().summary, awaitingHuman: 0 } });
    const text = formatVisualReview(m, 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1' });
    expect(text).toContain('Question: Is the old header intended?');
    expect(text).not.toMatch(/\b0 (screens? )?needs? your review/);
  });

  it('nothing pending: says nobody is needed', () => {
    const m = model({ phase: 'reviewed', needsYou: null, summary: { ...model().summary, awaitingHuman: 0 } });
    const text = formatVisualReview(m, 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1' });
    expect(text).toContain('Nothing to review.');
  });

  describe('checked before the mission was completed (Q3)', () => {
    const done = (a: VisualReviewAuditTask[]) => formatVisualReview(model({ phase: 'reviewed', needsYou: null, audits: a, audit: a[a.length - 1] ?? null }), 'Example', {
      audience: 'mcp', baseUrl: BASE, missionId: 'mission-1', missionStatus: 'completed', missionCompletedAt: '2026-03-10T11:00:00.000Z',
    });
    const ok = (endedAt: string): VisualReviewAuditTask => ({ id: A2, title: 'a', status: 'completed', round: 2, createdAt: '2026-03-10T09:30:00.000Z', endedAt, errorType: null, why: null });

    it('puts the completion time in the head', () => {
      expect(done([ok('2026-03-10T10:05:00.000Z')])).toContain('(mission mission-1, completed 2026-03-10 11:00 UTC)');
    });

    it('yes when an audit completed before the mission did', () => {
      expect(done([audits[0], ok('2026-03-10T10:05:00.000Z')])).toContain('Visually checked before the mission was completed: yes (round 2 audit completed 2026-03-10 10:05 UTC).');
    });

    it('no when the only completed audit ended after', () => {
      expect(done([ok('2026-03-10T12:00:00.000Z')])).toContain('Visually checked before the mission was completed: no (round 2 audit completed after it, 2026-03-10 12:00 UTC).');
    });

    it('no when every audit was cancelled or failed', () => {
      expect(done(audits)).toContain('Visually checked before the mission was completed: no (no audit completed; latest: round 2 failed).');
    });

    it('says the time is unknown rather than guessing', () => {
      const text = formatVisualReview(model({ phase: 'reviewed', needsYou: null }), 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1', missionStatus: 'completed', missionCompletedAt: null });
      expect(text).toContain('Visually checked before the mission was completed: unknown (completion time not recorded).');
    });

    it('says nothing about it for a mission that is not completed', () => {
      const text = formatVisualReview(model(), 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1', missionStatus: 'active' });
      expect(text).not.toMatch(/Visually checked before/);
    });
  });

  it('awaitingOnly lists only the screens that need review and says how many were left out', () => {
    const text = formatVisualReview(model(), 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1', awaitingOnly: true });
    expect(text).toContain(SHOT1);
    expect(text).not.toContain(SHOT2);
    expect(text).toMatch(/1 other screen not shown \(awaitingOnly\)/);
  });

  it('does not say "no visual audit" when audits exist but were cancelled before any screen', () => {
    const text = formatVisualReview(model({ phase: 'off', cells: [], queue: [], needsYou: null, summary: { ...model().summary, shots: 0, unsure: 0, issues: 0, awaitingHuman: 0, openFixes: 0 } }), 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1' });
    expect(text).not.toMatch(/No visual audit on this mission/);
    expect(text).toMatch(/no screens were captured/i);
    expect(text).toContain('cancelled');
  });

  it('still says "no visual audit" when there never was one', () => {
    const text = formatVisualReview(model({ phase: 'off', audit: null, audits: [], cells: [], queue: [] }), 'Example', { audience: 'mcp', baseUrl: BASE });
    expect(text).toMatch(/No visual audit on this mission/);
  });
});

describe('formatVisualReview: wrong-ref shots (visual-qa-auditor.md, "Page source")', () => {
  const SHOT3 = 'bbbbbbbb-0000-4000-8000-000000000003';
  const SHOT4 = 'bbbbbbbb-0000-4000-8000-000000000004';
  const MB = 'mission/example-abcd1234';
  const m = model({
    superseded: [{ shotId: SHOT3, route: '/app/example', viewport: 'mobile', ref: 'dev', expectedRef: MB, supersededBy: SHOT1 }],
    captureGaps: [{ shotId: SHOT4, route: '/app/other', viewport: 'desktop', ref: 'dev', expectedRef: MB, auditTaskId: A2, round: 2 }],
  });

  it('lists capture gaps as owed by the auditor, never as a human question', () => {
    const text = formatVisualReview(m, 'Example', { audience: 'mcp', baseUrl: 'https://example.test' });
    expect(text).toContain(`Capture gaps (1): shots from the wrong branch the auditor still has to recapture from ${MB}; not shown for review:`);
    expect(text).toContain(`  - /app/other desktop: captured from dev (round 2, shot https://example.test/app/artifacts/${SHOT4})`);
  });

  it('lists superseded wrong-ref shots, kept for audit, with what replaced them', () => {
    const text = formatVisualReview(m, 'Example', { audience: 'mcp', baseUrl: 'https://example.test' });
    expect(text).toContain(`Superseded (1): shots from the wrong branch, replaced by a shot from ${MB}; kept for audit, not shown for review:`);
    expect(text).toContain(`  - /app/example phone: captured from dev, replaced by https://example.test/app/artifacts/${SHOT1}`);
  });

  it('the reviewed phase copy counts capture gaps as the auditor\'s, not yours', () => {
    const copy = describeVisualPhase(model({ phase: 'reviewed', needsYou: null, summary: { ...model().summary, awaitingHuman: 0, captureGaps: 1 } }));
    expect(copy.detail).toContain('1 capture gap for the auditor');
  });

  it('says nothing about either when there are none', () => {
    const text = formatVisualReview(model(), 'Example', { audience: 'mcp' });
    expect(text).not.toContain('Capture gaps');
    expect(text).not.toContain('Superseded');
  });
});

describe('formatVisualReview for chat', () => {
  it('links each screenshot to its artifact page (never the image), and keeps the "not seen" line', () => {
    const text = formatVisualReview(model(), 'Example');
    expect(text).toContain(`/app/artifacts/${SHOT1}`);
    expect(text).toContain(`/app/artifacts/${SHOT2}`);
    expect(text).not.toMatch(/\/download|\/api\/artifacts\//);
    expect(text).toMatch(/You have not seen these images/);
    expect(text).toMatch(/round 1: cancelled/);
  });
});

describe('other visual evidence', () => {
  const MANUAL = 'dddddddd-0000-4000-8000-000000000001';
  const REPORT = 'dddddddd-0000-4000-8000-000000000002';
  const DIFF = 'dddddddd-0000-4000-8000-000000000003';
  const manualShot: VisualEvidenceArtifact = { id: MANUAL, type: 'screenshot', title: 'Settings page, mobile', metadata: {}, updatedAt: '2026-03-10T10:30:00.000Z' };
  const report: VisualEvidenceArtifact = {
    id: REPORT, type: 'report', title: 'Visual validation: settings redesign (final)', key: null,
    content: '# Visual validation\n\nChecked six screens on phone and desktop.\n\n**Verdict:** all checks passed.\n\nDetails follow.',
    metadata: {}, updatedAt: '2026-03-10T10:45:00.000Z',
  };
  const auditShot: VisualEvidenceArtifact = { id: SHOT1, type: 'screenshot', title: 'audit shot', metadata: { qa: { route: '/app/example' } } };
  const unrelated: VisualEvidenceArtifact[] = [
    { id: DIFF, type: 'diff', title: 'Visual validation diff', metadata: {} },
    { id: 'eeeeeeee-0000-4000-8000-000000000001', type: 'report', title: 'Weekly cost report', content: 'All good.', metadata: {} },
  ];
  const off = () => model({ phase: 'off', audit: null, audits: [], cells: [], queue: [], needsYou: null, summary: { ...model().summary, shots: 0, ok: 0, issues: 0, unsure: 0, awaitingHuman: 0, unreviewed: 0, rounds: 0, openFixes: 0 } });
  const all = [auditShot, manualShot, report, ...unrelated];
  const mcp = (m: VisualReviewModel, artifacts: VisualEvidenceArtifact[] | null, extra: Record<string, unknown> = {}) =>
    formatVisualReview(m, 'Example', { audience: 'mcp', baseUrl: BASE, missionId: 'mission-1', artifacts, ...extra });

  it('classifies: non-audit screenshots and validation-like reports only', () => {
    const ev = otherVisualEvidence(all, model());
    expect(ev.screenshots.map(a => a.id)).toEqual([MANUAL]);
    expect(ev.reports.map(a => a.id)).toEqual([REPORT]);
  });

  it('never counts a shot the model already shows, even without metadata.qa', () => {
    const ev = otherVisualEvidence([{ id: SHOT2, type: 'screenshot', title: 'x', metadata: {} }], model());
    expect(ev.screenshots).toEqual([]);
  });

  it('with no audit, does not claim no visual QA happened; lists the manual evidence with links', () => {
    const text = mcp(off(), all);
    expect(text).not.toMatch(/No visual audit on this mission/);
    expect(text).not.toMatch(/no screens were/i);
    expect(text).toContain('No automatic visual audit ran; manual visual evidence below.');
    expect(text).toContain('Other visual evidence (1 screenshot, 1 report):');
    expect(text).toMatch(/"Settings page, mobile" \(phone\)/);
    expect(text).toContain(`${BASE}/app/artifacts/${MANUAL}`);
    expect(text).toContain('"Visual validation: settings redesign (final)"');
    expect(text).toContain('updated 2026-03-10 10:45 UTC');
    expect(text).toContain('Verdict: all checks passed.');
    expect(text).toContain(`${BASE}/app/artifacts/${REPORT}`);
    expect(text).not.toContain(DIFF);
    expect(text).not.toContain('Weekly cost report');
    // Never an image: no download route for the manual shot.
    expect(text).not.toContain(`/api/artifacts/${MANUAL}/download`);
  });

  it('a report with no verdict line shows its first prose line instead', () => {
    const text = mcp(off(), [{ ...report, content: '## Heading\n\nLooked at the phone layout only.' }]);
    expect(text).toContain('Looked at the phone layout only.');
  });

  it('matches on key too, and caps each list with "N more"', () => {
    const shots = Array.from({ length: 8 }, (_, i): VisualEvidenceArtifact => ({ id: `ffffffff-0000-4000-8000-00000000000${i}`, type: 'screenshot', title: `Shot ${i}`, metadata: {}, updatedAt: `2026-03-10T10:0${i}:00.000Z` }));
    const reports = Array.from({ length: 5 }, (_, i): VisualEvidenceArtifact => ({ id: `99999999-0000-4000-8000-00000000000${i}`, type: 'analysis', title: `Notes ${i}`, key: `visual-qa-notes-${i}`, content: 'Result: fine.', metadata: {} }));
    const text = mcp(off(), [...shots, ...reports]);
    expect(text).toContain('Other visual evidence (8 screenshots, 5 reports):');
    expect(text).toMatch(/3 more screenshots not shown/);
    expect(text).toMatch(/2 more reports not shown/);
    // Newest first.
    expect(text.indexOf('Shot 7')).toBeLessThan(text.indexOf('Shot 6'));
    expect(text).not.toContain('Shot 0');
  });

  it('with an audit, adds the section after the audit screens', () => {
    const text = mcp(model(), all);
    expect(text).toContain('Other visual evidence (1 screenshot, 1 report):');
    expect(text.indexOf('/app/example:')).toBeLessThan(text.indexOf('Other visual evidence'));
  });

  it('audits that captured nothing: points at the manual evidence', () => {
    const m = model({ phase: 'off', cells: [], queue: [], needsYou: null, summary: { ...model().summary, shots: 0, unsure: 0, issues: 0, awaitingHuman: 0, openFixes: 0 } });
    const text = mcp(m, [report]);
    expect(text).toMatch(/the audit captured no screens; other visual evidence below/i);
    expect(text).not.toMatch(/No screenshots yet/);
  });

  it('Q3: a completed mission with only manual evidence says so instead of a bare "no"', () => {
    const text = mcp(off(), [report], { missionStatus: 'completed', missionCompletedAt: '2026-03-10T11:00:00.000Z' });
    expect(text).toContain('Visually checked before the mission was completed: no automatic audit ran; manual evidence dated before completion ("Visual validation: settings redesign (final)", 2026-03-10 10:45 UTC).');
  });

  it('no artifacts (or none passed): unchanged text', () => {
    expect(mcp(off(), [])).toBe(mcp(off(), null));
    expect(mcp(off(), unrelated)).toMatch(/No visual audit on this mission/);
  });

  it('chat: same section, page links but no image links, and it does not claim the images were seen', () => {
    const text = formatVisualReview(off(), 'Example', { artifacts: all });
    expect(text).toContain('No automatic visual audit ran; manual visual evidence below.');
    expect(text).toContain('Verdict: all checks passed.');
    expect(text).toContain(`/app/artifacts/${MANUAL}`);
    expect(text).not.toMatch(/\/download|\/api\/artifacts\//);
    expect(text).toMatch(/You have not seen these screenshots/);
  });
});

describe('describeVisualPhase', () => {
  it('is the one phase copy', () => {
    expect(describeVisualPhase(model()).label).toBe('1 to review');
  });
});
