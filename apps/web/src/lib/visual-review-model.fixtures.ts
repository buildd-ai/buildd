/**
 * A `VisualReviewModel` for every phase, for dev fixtures and component tests
 * (docs/design/visual-qa-human-review.md). Pure and deterministic.
 *
 * Illustrative only: placeholder ids, made-up routes and findings, and
 * self-made SVG page sketches as images, never captures (the repo is public,
 * and a real screenshot can hold real content). Built through
 * `buildVisualReviewModel`, so a fixture is always a shape the real model can
 * produce.
 */
import type { HumanShotReview, VisualReviewModel, VisualReviewPhase } from '@buildd/shared';
import { VISUAL_AUDITOR_ROLE_SLUG, BOOT_FAILURE_QUESTION_PREFIX } from './mission-visual-review';
import {
  NO_BROWSER_RUNNER_AFTER_MS,
  buildVisualReviewModel,
  visualReviewCellKey,
  type BuildVisualReviewInput,
  type VisualReviewShotRow,
  type VisualReviewTaskInput,
} from './visual-review-model';

const BASE = Date.parse('2026-03-10T10:00:00.000Z');
const at = (min: number) => new Date(BASE + min * 60_000).toISOString();
export const VISUAL_REVIEW_FIXTURE_NOW = BASE + 180 * 60_000;

const PALETTE = {
  dark: { bg: '#1a1816', card: '#2a2724', block: '#4b453f', line: '#3a3531' },
  light: { bg: '#eee9e3', card: '#ffffff', block: '#cdc5bb', line: '#d8d1c8' },
} as const;

/** A wireframe page: header bar, accent, a few cards. `flag` outlines the header in red. */
export function visualReviewSketch(viewport: 'mobile' | 'desktop', theme: 'dark' | 'light' = 'dark', flag = false): string {
  const [w, h] = viewport === 'mobile' ? [390, 844] : [1280, 900];
  const c = PALETTE[theme];
  const pad = viewport === 'mobile' ? 16 : 40;
  const cardW = viewport === 'mobile' ? w - pad * 2 : (w - pad * 3) / 2;
  const cards = [0, 1, 2, 3].map((i) => {
    const col = viewport === 'mobile' ? 0 : i % 2;
    const row = viewport === 'mobile' ? i : Math.floor(i / 2);
    const x = pad + col * (cardW + pad);
    const y = 120 + row * 170;
    return `<rect x="${x}" y="${y}" width="${cardW}" height="140" fill="${c.card}" stroke="${c.line}"/>`
      + `<rect x="${x + 16}" y="${y + 20}" width="${cardW * 0.5}" height="14" fill="${c.block}"/>`
      + `<rect x="${x + 16}" y="${y + 48}" width="${cardW * 0.8}" height="10" fill="${c.line}"/>`;
  }).join('');
  const flagRect = flag
    ? `<rect x="${pad - 6}" y="20" width="${w - pad * 2 + 12}" height="64" fill="none" stroke="#d4736a" stroke-width="4"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">`
    + `<rect width="${w}" height="${h}" fill="${c.bg}"/>`
    + `<rect x="${pad}" y="32" width="${w * 0.45}" height="28" fill="${c.block}"/>`
    + `<rect x="${w - pad - 60}" y="32" width="60" height="28" fill="#f4811f"/>`
    + cards + flagRect + '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

type Verdict = 'ok' | 'issue' | 'unsure';
type Viewport = 'mobile' | 'desktop';

function shotRow(id: string, workerId: string, taskId: string, min: number, route: string, viewport: Viewport, verdict: Verdict, finding: string, fixTaskId?: string): VisualReviewShotRow {
  return {
    id,
    type: 'screenshot',
    workerId,
    taskId,
    createdAt: at(min),
    title: null,
    metadata: { qa: { runKey: `fixture-${workerId}`, route, viewport, verdict, finding, theme: 'dark', ...(fixTaskId ? { fixTaskId } : {}) } },
  };
}

const auditTask = (id: string, round: number, status: string, workerId: string | null, extra: Partial<VisualReviewTaskInput> = {}): VisualReviewTaskInput => ({
  id,
  title: round > 1 ? `[surface audit] round ${round}: Fixture mission` : '[surface audit] Fixture mission',
  status,
  roleSlug: VISUAL_AUDITOR_ROLE_SLUG,
  createdAt: at(round > 1 ? 90 : 0),
  updatedAt: at(round > 1 ? 90 : 0),
  dependsOn: ['fixture-build'],
  context: round > 1 ? { surfaceAuditRound: round } : {},
  workers: workerId ? [{ id: workerId, status: status === 'completed' ? 'completed' : 'running', startedAt: at(round > 1 ? 91 : 1) }] : [],
  ...extra,
});

const buildTask = (status: string, min = 0): VisualReviewTaskInput => ({
  id: 'fixture-build', title: 'Build the fixture screens', status, createdAt: at(0), updatedAt: at(min),
});

/** Round 1: seven screens across four routes, every verdict represented. */
const ROUND_1: VisualReviewShotRow[] = [
  shotRow('fixture-shot-01', 'fixture-w1', 'fixture-audit-1', 2, '/app/tasks', 'mobile', 'ok', 'Task list fits at 390px; the filter row wraps cleanly.'),
  shotRow('fixture-shot-02', 'fixture-w1', 'fixture-audit-1', 3, '/app/tasks', 'desktop', 'ok', 'Two-column layout; primary action top right.'),
  shotRow('fixture-shot-03', 'fixture-w1', 'fixture-audit-1', 4, '/app/tasks/:id', 'mobile', 'issue', 'Header title overflows the viewport by about 40px.', 'fixture-fix-1'),
  shotRow('fixture-shot-04', 'fixture-w1', 'fixture-audit-1', 5, '/app/tasks/:id', 'desktop', 'ok', 'Header and status badge align on one line.'),
  shotRow('fixture-shot-05', 'fixture-w1', 'fixture-audit-1', 6, '/app/missions/:id', 'mobile', 'unsure', 'The empty state shows two headings; it may be intended.'),
  shotRow('fixture-shot-06', 'fixture-w1', 'fixture-audit-1', 7, '/app/missions/:id', 'desktop', 'ok', 'Board renders with the band and four tiles.'),
  shotRow('fixture-shot-07', 'fixture-w1', 'fixture-audit-1', 8, '/app/settings', 'mobile', 'ok', 'Settings rows are 48px tall and readable.'),
];
/** Round 2: re-shoots only the fixed route. */
const ROUND_2: VisualReviewShotRow[] = [
  shotRow('fixture-shot-08', 'fixture-w2', 'fixture-audit-2', 100, '/app/tasks/:id', 'mobile', 'ok', 'Resolved: the title now truncates with an ellipsis.'),
];

const fixTask = (status: string, merged = false): VisualReviewTaskInput => ({
  id: 'fixture-fix-1',
  title: '[surface fix] /app/tasks/:id: Header title overflows the viewport by about 40px.',
  status,
  createdAt: at(10),
  updatedAt: at(merged ? 80 : 10),
  workers: [{
    id: 'fixture-wf', status: status === 'completed' ? 'completed' : 'running', startedAt: at(12),
    prUrl: 'https://example.test/pulls/1', prNumber: 1, mergedAt: merged ? at(80) : null,
  }],
});

function review(artifactId: string, route: string, viewport: Viewport, agentVerdict: Verdict, over: Partial<HumanShotReview>): HumanShotReview {
  return {
    id: `fixture-review-${artifactId}`,
    artifactId,
    auditTaskId: 'fixture-audit-1',
    round: 1,
    cellKey: visualReviewCellKey(route, viewport, null),
    route,
    viewport,
    agentVerdict,
    decision: 'looks_right',
    relation: 'waive',
    note: null,
    fixTaskId: null,
    cancelledFixTaskId: null,
    reviewerUserId: null,
    reviewerLabel: 'Fixture reviewer',
    createdAt: at(150),
    supersededAt: null,
    ...over,
  };
}

function inputFor(phase: VisualReviewPhase): BuildVisualReviewInput {
  const base = { missionId: 'fixture-mission', now: VISUAL_REVIEW_FIXTURE_NOW, requiredRoutesOf: () => ['/app/tasks', '/app/tasks/:id', '/app/missions/:id', '/app/settings'] };
  const waived = review('fixture-shot-05', '/app/missions/:id', 'mobile', 'unsure', {});
  switch (phase) {
    case 'off':
      return { ...base, shots: [], tasks: [buildTask('completed')] };
    case 'waiting_deps':
      return { ...base, shots: [], tasks: [buildTask('in_progress'), auditTask('fixture-audit-1', 1, 'pending', null)] };
    case 'queued':
      return {
        ...base, shots: [],
        tasks: [buildTask('completed', 176), auditTask('fixture-audit-1', 1, 'pending', null)],
        browserRunnerOnline: true,
      };
    case 'no_browser_runner':
      return {
        ...base, shots: [],
        tasks: [buildTask('completed', Math.floor((VISUAL_REVIEW_FIXTURE_NOW - BASE - NO_BROWSER_RUNNER_AFTER_MS) / 60_000) - 30), auditTask('fixture-audit-1', 1, 'pending', null)],
        browserRunnerOnline: false,
      };
    case 'capturing':
      return { ...base, shots: ROUND_1.slice(0, 3), tasks: [buildTask('completed'), auditTask('fixture-audit-1', 1, 'in_progress', 'fixture-w1')] };
    case 'boot_failed':
      return {
        ...base, shots: [],
        tasks: [buildTask('completed'), auditTask('fixture-audit-1', 1, 'waiting_input', 'fixture-w1', {
          workers: [{ id: 'fixture-w1', status: 'waiting_input', startedAt: at(1), waitingFor: { type: 'question', prompt: `${BOOT_FAILURE_QUESTION_PREFIX}: the dev server exited on start` } }],
        })],
      };
    case 'stalled':
      return { ...base, shots: [], tasks: [buildTask('completed'), auditTask('fixture-audit-1', 1, 'failed', 'fixture-w1', { errorType: 'infra_stalled' })] };
    case 'needs_you':
      return { ...base, shots: ROUND_1, tasks: [buildTask('completed'), auditTask('fixture-audit-1', 1, 'completed', 'fixture-w1'), fixTask('in_progress')] };
    case 'fixing':
      // Round 2 already re-shot the fixed route while a second fix is open.
      return {
        ...base,
        shots: [...ROUND_1, ...ROUND_2],
        tasks: [
          buildTask('completed'),
          auditTask('fixture-audit-1', 1, 'completed', 'fixture-w1'),
          auditTask('fixture-audit-2', 2, 'completed', 'fixture-w2', { dependsOn: ['fixture-fix-1'] }),
          fixTask('completed', true),
          { id: 'fixture-fix-2', title: '[surface fix] /app/settings: Toggle label clips at 320px.', status: 'in_progress', createdAt: at(120), updatedAt: at(120), workers: [] },
        ],
        reviews: [waived],
      };
    case 'reviewed':
      return {
        ...base,
        shots: [...ROUND_1, ...ROUND_2],
        tasks: [
          buildTask('completed'),
          auditTask('fixture-audit-1', 1, 'completed', 'fixture-w1'),
          auditTask('fixture-audit-2', 2, 'completed', 'fixture-w2', { dependsOn: ['fixture-fix-1'] }),
          fixTask('completed', true),
        ],
        reviews: [waived, review('fixture-shot-06', '/app/missions/:id', 'desktop', 'ok', { relation: 'agree' })],
      };
  }
}

/**
 * The fixture model for `phase`, with every image an SVG sketch data URL (an
 * `issue` shot gets a red outline). Pass `{ expired: true }` to point one
 * shot at a path that does not exist, for the expired-tile state.
 */
export function buildVisualReviewFixtureModel(phase: VisualReviewPhase, opts: { expired?: boolean } = {}): VisualReviewModel {
  const model = buildVisualReviewModel(inputFor(phase));
  let first = true;
  const cells = model.cells.map(cell => ({
    ...cell,
    history: cell.history.map((h) => {
      const src = opts.expired && first ? '/fixtures/expired-shot.png' : visualReviewSketch(h.shot.qa.viewport, 'dark', h.agentVerdict === 'issue');
      first = false;
      return { ...h, shot: { ...h.shot, src } };
    }),
  })).map(cell => ({ ...cell, current: cell.history[cell.history.length - 1] }));
  return { ...model, cells };
}
