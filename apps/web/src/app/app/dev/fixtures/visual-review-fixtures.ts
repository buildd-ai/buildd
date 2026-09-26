/**
 * The `?state=visual-review` dev fixture: the mission Visual review strip
 * (docs/design/visual-qa-auditor.md) with placeholder shots.
 *
 * Illustrative fixtures only. The images are self-made SVG page sketches,
 * never captures: the repo is public, and a real screenshot can hold real
 * content. One shot points at a path that does not exist, to show the
 * "expired" tile. Deterministic: no Date.now or random at module scope.
 */
import type { VisualShot } from '@/lib/mission-visual-review';
import { mockWorkers } from './fixtures-data';

export const VISUAL_REVIEW_FIXTURE_STATE = 'visual-review';

/** Every `?state=` the fixtures page understands. */
export const FIXTURE_VIEWS: readonly string[] = [...Object.keys(mockWorkers), VISUAL_REVIEW_FIXTURE_STATE];

export function isFixtureView(value: string | null | undefined): value is string {
  return value != null && FIXTURE_VIEWS.includes(value);
}

const PALETTE = {
  dark: { bg: '#1a1816', card: '#2a2724', block: '#4b453f', line: '#3a3531' },
  light: { bg: '#eee9e3', card: '#ffffff', block: '#cdc5bb', line: '#d8d1c8' },
} as const;

/** A wireframe page: header bar, accent, a few cards. `flag` outlines an area in red. */
function sketch(viewport: 'mobile' | 'desktop', theme: 'dark' | 'light', flag = false): string {
  const [w, h] = viewport === 'mobile' ? [390, 844] : [1280, 900];
  const c = PALETTE[theme];
  const pad = viewport === 'mobile' ? 16 : 40;
  const cardW = viewport === 'mobile' ? w - pad * 2 : (w - pad * 3) / 2;
  const cards = [0, 1, 2, 3].map(i => {
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

const RUN = 'fixture-run-1';

function shot(
  id: string,
  minute: number,
  route: string,
  viewport: 'mobile' | 'desktop',
  verdict: 'ok' | 'issue' | 'unsure',
  finding: string,
  extra: { theme?: 'dark' | 'light'; fixTaskId?: string; src?: string } = {},
): VisualShot {
  const theme = extra.theme ?? 'dark';
  return {
    id,
    createdAt: `2026-03-10T10:${String(minute).padStart(2, '0')}:00.000Z`,
    src: extra.src ?? sketch(viewport, theme, verdict === 'issue'),
    qa: {
      runKey: RUN,
      route,
      viewport,
      finding,
      verdict,
      theme,
      ...(extra.fixTaskId ? { fixTaskId: extra.fixTaskId } : {}),
    },
  };
}

export const visualReviewFixtureShots: readonly VisualShot[] = [
  shot('fx-1', 1, '/app/tasks', 'mobile', 'issue', 'The header wraps onto two lines and pushes the status badge off-screen.', { fixTaskId: 'fixture-fix-1' }),
  shot('fx-2', 2, '/app/tasks', 'desktop', 'ok', 'Header and list render in one row; nothing clipped.'),
  shot('fx-3', 3, '/app/tasks/:id', 'mobile', 'unsure', 'The retry button sits under the fold; unclear whether that is intended.'),
  shot('fx-4', 4, '/app/tasks/:id', 'desktop', 'ok', 'Detail panel and timeline align.', { theme: 'light' }),
  shot('fx-5', 5, '/app/missions', 'mobile', 'ok', 'Cards stack cleanly at 390px.'),
  shot('fx-6', 6, '/app/missions', 'desktop', 'issue', 'The empty state overlaps the filter bar.', { fixTaskId: 'fixture-fix-2' }),
  shot('fx-7', 7, '/app/missions/:id', 'mobile', 'ok', 'Delivery line wraps between steps, not mid-step.', { src: '/dev-fixtures/expired-shot.png' }),
  shot('fx-8', 8, '/app/missions/:id', 'desktop', 'ok', 'Delivery block and task list render as expected.'),
];
