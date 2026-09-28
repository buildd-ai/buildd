/**
 * The shared visual review text (visual-review-text.ts): the chat's
 * get_visual_review and the MCP get_visual_review action both read it.
 * Illustrative ids and routes only.
 */
import { describe, expect, it } from 'bun:test';
import type { VisualReviewCell, VisualReviewModel, VisualReviewAuditTask } from '@buildd/shared';
import { formatVisualReview, describeVisualPhase } from '../visual-review-text';

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
  { id: A1, title: '[surface audit] Example', status: 'cancelled', round: 1, createdAt: '2026-03-10T09:00:00.000Z', errorType: null, why: null },
  { id: A2, title: '[surface audit] Example (round 2)', status: 'failed', round: 2, createdAt: '2026-03-10T09:30:00.000Z', errorType: 'max_turns', why: 'Ran out of turns before the last route.' },
];

function model(over: Partial<VisualReviewModel> = {}): VisualReviewModel {
  const cells = [
    cell(SHOT1, 'mobile', 'unsure', 'Header may overlap.'),
    { ...cell(SHOT2, 'desktop', 'issue', 'Two headings.'), current: { ...cell(SHOT2, 'desktop', 'issue', 'Two headings.').current, fixTask: { id: FIX, title: '[surface fix] x', status: 'in_progress', prUrl: null, prNumber: 12, mergedAt: null, origin: 'auditor' as const } } },
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
    expect(text).toContain(`round 1: cancelled (task ${A1}): no reason recorded`);
    expect(text).toContain(`round 2: failed (task ${A2}): max_turns; Ran out of turns before the last route.`);
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
    expect(text).toMatch(/phone; round 2; agent: unsure; "Header may overlap\."; human: not reviewed yet, needs review/);
    expect(text).toMatch(new RegExp(`fix: in progress, PR #12 \\(task ${FIX}\\)`));
    expect(text).toContain('1 need your review.');
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

describe('formatVisualReview for chat', () => {
  it('carries no links and keeps the "not seen" line', () => {
    const text = formatVisualReview(model(), 'Example');
    expect(text).not.toMatch(/\/download|\/app\/artifacts\//);
    expect(text).toMatch(/You have not seen these images/);
    expect(text).toMatch(/round 1: cancelled/);
  });
});

describe('describeVisualPhase', () => {
  it('is the one phase copy', () => {
    expect(describeVisualPhase(model()).label).toBe('1 to review');
  });
});
