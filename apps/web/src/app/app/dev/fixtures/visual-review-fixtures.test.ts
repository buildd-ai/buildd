import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VISUAL_REVIEW_PHASES, type VisualReviewModel } from '@buildd/shared';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
import { createFixtureVisualReviewTransport } from '@/components/visual-review/fixture-transport';
import { buildDecisionRequest, VisualReviewRequestError } from '@/components/visual-review/review-transport';
import { mockWorkers } from './fixtures-data';
import {
  COMPARE_START_KEY,
  FIXTURE_VIEWS,
  VISUAL_REVIEW_FIXTURE_STATE,
  isFixtureView,
  parseVisualReviewFixtureParams,
  visualReviewFixtureLinks,
} from './visual-review-fixtures';

/**
 * The `?state=visual-review` fixture renders the visual review components
 * over fixture models. Images are self-made SVGs, never captures: the repo is
 * public. Decisions go to an in-memory transport.
 */

function expectValidModel(m: VisualReviewModel) {
  const keys = new Set(m.cells.map(c => c.key));
  expect(keys.size).toBe(m.cells.length);
  expect([...m.queue].sort()).toEqual([...keys].sort());
  for (const c of m.cells) {
    expect(c.history.length).toBeGreaterThan(0);
    expect(c.current).toEqual(c.history[c.history.length - 1]);
    expect(c.current.shot.src.startsWith('data:image/svg+xml,') || c.current.shot.src === '/fixtures/expired-shot.png').toBe(true);
    expect(c.current.shot.src).not.toContain('/api/artifacts/');
  }
  expect(m.summary.shots).toBe(m.cells.length);
  expect(m.summary.reviewed + m.summary.unreviewed).toBe(m.cells.length);
}

describe('visual review fixture', () => {
  it('is a fixture view alongside the worker states, without joining mockWorkers', () => {
    expect(FIXTURE_VIEWS).toEqual([...Object.keys(mockWorkers), VISUAL_REVIEW_FIXTURE_STATE, 'mission-board-visual', 'mission-list-executor', 'mission-check-ins', 'task-evidence', 'evidence-storage', 'task-shipped', 'commit-checks', 'answer-states', 'onboarding']);
    expect(VISUAL_REVIEW_FIXTURE_STATE in mockWorkers).toBe(false);
    expect(isFixtureView('visual-review')).toBe(true);
    expect(isFixtureView('waiting-input')).toBe(true);
    expect(isFixtureView('nope')).toBe(false);
    expect(isFixtureView(null)).toBe(false);
  });

  it('builds a valid model for every phase the page links', () => {
    for (const link of visualReviewFixtureLinks()) {
      const p = parseVisualReviewFixtureParams(new URLSearchParams(link.href.slice(1)));
      const m = buildVisualReviewFixtureModel(p.phase, p.options);
      expect(m.phase).toBe(p.phase);
      expectValidModel(m);
    }
    const linked = new Set(visualReviewFixtureLinks().map(l => parseVisualReviewFixtureParams(new URLSearchParams(l.href.slice(1))).phase));
    for (const phase of VISUAL_REVIEW_PHASES) expect(linked.has(phase)).toBe(true);
  });

  it('parses views, falling back on unknown values', () => {
    expect(parseVisualReviewFixtureParams(new URLSearchParams('phase=boot_failed'))).toMatchObject({ view: 'tray', phase: 'boot_failed' });
    expect(parseVisualReviewFixtureParams(new URLSearchParams('phase=nope&view=nope'))).toMatchObject({ view: 'tray', phase: 'needs_you' });
    expect(parseVisualReviewFixtureParams(new URLSearchParams('phase=needs_you&reason=question')).options.needsYou).toBe('question');
    const compare = parseVisualReviewFixtureParams(new URLSearchParams('view=compare'));
    expect(compare).toMatchObject({ view: 'compare', compare: true, startKey: COMPARE_START_KEY });
    expect(parseVisualReviewFixtureParams(new URLSearchParams('view=reviewed')).phase).toBe('reviewed');
    expect(parseVisualReviewFixtureParams(new URLSearchParams('view=deck-phone&expired=1')).options.expired).toBe(true);
  });

  it('the deck set has two rounds, mixed human reviews, an unsure and an issue with a fix', () => {
    const p = parseVisualReviewFixtureParams(new URLSearchParams('view=deck'));
    const m = buildVisualReviewFixtureModel(p.phase, p.options);
    expect(m.summary.rounds).toBe(2);
    expect(m.cells.find(c => c.key === COMPARE_START_KEY)!.history.map(h => h.round)).toEqual([1, 2]);
    expect(m.summary.reviewed).toBeGreaterThan(0);
    expect(m.summary.unreviewed).toBeGreaterThan(0);
    expect(m.cells.some(c => c.needsHuman)).toBe(true);
    const issue = m.cells.find(c => c.current.agentVerdict === 'issue')!;
    expect(issue.current.fixTask?.prNumber).toBeGreaterThan(0);
    expect(m.cells.find(c => c.key === m.queue[0])!.current.agentVerdict).toBe('unsure');
  });

  it('the page no longer imports the retired strip', () => {
    const src = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
    expect(src).not.toContain('VisualReviewStrip');
    expect(src).not.toContain('missions/[id]/');
  });
});

describe('fixture transport', () => {
  const setup = () => {
    const t = createFixtureVisualReviewTransport('needs_you', { needsYou: 'unsure', scenario: 'deck' });
    return { t, m: t.model() };
  };

  it('waives an unsure cell and moves on from needs_you', async () => {
    const { t, m } = setup();
    const unsure = m.cells.find(c => c.needsHuman)!;
    const res = await t.decide(buildDecisionRequest({ cells: [unsure], decision: 'looks_right' }));
    expect(res.reviews.map(r => r.relation)).toEqual(['waive']);
    expect(res.fixTaskId).toBeNull();
    expect(res.model.summary.awaitingHuman).toBe(0);
    expect(res.model.phase).not.toBe('needs_you');
  });

  it('files one fix for both viewports, titled by the route and the note, and undo cancels it', async () => {
    const { t, m } = setup();
    const pair = m.cells.filter(c => c.route === '/app/missions/:id');
    const res = await t.decide(buildDecisionRequest({ cells: pair, decision: 'needs_fix', note: 'Drop the second heading.' }));
    expect(res.reviews).toHaveLength(2);
    expect(res.fixTaskId).not.toBeNull();
    const fix = res.model.fixTasks.find(f => f.id === res.fixTaskId)!;
    expect(fix.title).toBe('[surface fix] /app/missions/:id: Drop the second heading.');
    // One undo takes back the whole tap, both viewports, like the server.
    const u = await t.undo(res.reviews[0].id);
    expect([...u.supersededIds].sort()).toEqual(res.reviews.map(r => r.id).sort());
    expect(u.cancelledFixTaskIds).toEqual([res.fixTaskId!]);
    const after = t.model();
    expect(after.fixTasks.find(f => f.id === res.fixTaskId)!.status).toBe('cancelled');
    expect(after.cells.filter(c => c.route === '/app/missions/:id').every(c => !c.current.review)).toBe(true);
  });

  it('answers 409 stale with the fresh model when the expected verdict changed', async () => {
    const { t, m } = setup();
    const cell = m.cells[0];
    const req = buildDecisionRequest({ cells: [cell], decision: 'looks_right' });
    req.expected[cell.current.shot.id] = cell.current.agentVerdict === 'ok' ? 'issue' : 'ok';
    const err = await t.decide(req).catch(e => e);
    expect(err).toBeInstanceOf(VisualReviewRequestError);
    expect(err.stale?.model.missionId).toBe(m.missionId);
    expect(err.stale?.cells.map((c: { key: string }) => c.key)).toEqual([cell.key]);
  });

  it('a started fix cannot be waived away: it gets guidance instead', async () => {
    const { t, m } = setup();
    const issue = m.cells.find(c => c.current.agentVerdict === 'issue')!;
    const res = await t.decide(buildDecisionRequest({ cells: [issue], decision: 'looks_right' }));
    expect(res.cancelledFixTaskId).toBeNull();
    expect(res.guidanceTaskId).toBe(issue.current.fixTask!.id);
    expect(res.reviews[0].relation).toBe('dispute');
  });
});
