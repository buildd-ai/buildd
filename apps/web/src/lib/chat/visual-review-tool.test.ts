/**
 * get_visual_review (docs/design/visual-qa-human-review.md, Chat): a text-only
 * read of the mission's visual review. Illustrative fixtures only.
 */
import { describe, expect, it } from 'bun:test';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
import { refsFromCalls } from './object-refs';
import type { ApiCall } from './in-process-api';
import { formatVisualReview, runGetVisualReview } from './visual-review-tool';

const deck = () => buildVisualReviewFixtureModel('needs_you', { scenario: 'deck' });

describe('formatVisualReview', () => {
  it('lists every current screen with route, viewport, round, verdict, finding, decision and fix', () => {
    const m = deck();
    const text = formatVisualReview(m, 'Fixture mission');
    for (const c of m.cells) {
      expect(text).toContain(c.route);
      expect(text).toContain(c.current.finding);
    }
    expect(text).toContain('phone');
    expect(text).toContain('desktop');
    expect(text).toMatch(/round 2/);
    expect(text).toMatch(/agent: unsure/);
    expect(text).toMatch(/you: looks right \(agreed\)/);
    expect(text).toMatch(/fix: .*in progress.*#2/);
    expect(text).toMatch(/not reviewed yet/);
  });

  it('leads with what needs the human: unsure and issues first, grouped by route', () => {
    const text = formatVisualReview(deck(), 'Fixture mission');
    const firstUnsure = text.indexOf('agent: unsure');
    const firstOk = text.indexOf('agent: ok');
    expect(firstUnsure).toBeGreaterThan(-1);
    expect(firstUnsure).toBeLessThan(firstOk);
  });

  it('never carries an image: no download URL, no data URL, no signed link', () => {
    const text = formatVisualReview(deck(), 'Fixture mission');
    expect(text).not.toMatch(/\/download|data:image|https?:\/\/[^\s]*\.(png|jpe?g|webp)|X-Amz/i);
    expect(text).toMatch(/You have not seen these images/);
  });

  it('gives the artifact page link of every current screen, so the user can ask for links', () => {
    const m = deck();
    const text = formatVisualReview(m, 'Fixture mission');
    for (const c of m.cells) expect(text).toContain(`/app/artifacts/${encodeURIComponent(c.current.shot.id)}`);
  });

  it('says so plainly when there is no audit, or no shots yet', () => {
    expect(formatVisualReview(buildVisualReviewFixtureModel('off'), 'M')).toMatch(/No visual audit/);
    expect(formatVisualReview(buildVisualReviewFixtureModel('no_browser_runner'), 'M')).toMatch(/no browser runner/i);
  });
});

describe('runGetVisualReview', () => {
  it('reads the mission, its review and its artifacts through three GETs and returns text plus a mission ref', async () => {
    const calls: ApiCall[] = [];
    const endpoints: string[] = [];
    const m = deck();
    const api = async (endpoint: string, opts: { method?: string } = {}) => {
      const method = opts.method ?? 'GET';
      endpoints.push(endpoint);
      const body = endpoint.endsWith('/visual-review')
        ? { model: m }
        : endpoint.includes('/artifacts?')
          ? { artifacts: [{ id: 'fixture-diff', type: 'diff', title: 'A diff', workspaceId: 'ws' }] }
          : { id: 'fixture-mission', title: 'Fixture mission', workspaceId: 'ws', status: 'active' };
      calls.push({ method, path: endpoint.split('?')[0], status: 200, body });
      return body;
    };
    const out = await runGetVisualReview(api as never, { missionId: 'fixture-mission' });
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /api/missions/fixture-mission',
      'GET /api/missions/fixture-mission/visual-review',
      'GET /api/missions/fixture-mission/artifacts',
    ]);
    // Bounded read: only evidence types, newest 100, bodies cut to 2KB in SQL.
    expect(endpoints[2]).toBe('/api/missions/fixture-mission/artifacts?types=screenshot,report,analysis,summary,walkthrough&limit=100&preview=1');
    expect(out.content[0].text).toContain('Fixture mission');
    expect(refsFromCalls(calls)).toEqual([expect.objectContaining({ kind: 'mission', id: 'fixture-mission' })]);
  });

  it('adds manual visual evidence (page links, no image links) and a card for the validation report only', async () => {
    const calls: ApiCall[] = [];
    const off = buildVisualReviewFixtureModel('off');
    const artifacts = [
      { id: 'fixture-report', type: 'report', title: 'Visual validation: fixture (final)', content: 'Verdict: all checks passed.', workspaceId: 'ws', updatedAt: '2026-03-10T10:45:00.000Z' },
      { id: 'fixture-diff', type: 'diff', title: 'A diff', workspaceId: 'ws' },
    ];
    const api = async (endpoint: string) => {
      const body = endpoint.endsWith('/visual-review') ? { model: off }
        : endpoint.includes('/artifacts?') ? { artifacts }
          : { id: 'fixture-mission', title: 'Fixture mission', workspaceId: 'ws', status: 'completed' };
      calls.push({ method: 'GET', path: endpoint.split('?')[0], status: 200, body });
      return body;
    };
    const out = await runGetVisualReview(api as never, { missionId: 'fixture-mission' });
    const text = out.content[0].text;
    expect(text).not.toMatch(/No visual audit on this mission/);
    expect(text).toContain('Verdict: all checks passed.');
    expect(text).toContain('/app/artifacts/fixture-report');
    expect(text).not.toMatch(/\/download|\/api\/artifacts\//);
    const refs = refsFromCalls(calls);
    expect(refs.map(r => `${r.kind}:${r.id}`)).toEqual(['mission:fixture-mission', 'artifact:fixture-report']);
  });

  it('needs a missionId', async () => {
    const out = await runGetVisualReview((async () => ({})) as never, {});
    expect(out.isError).toBe(true);
  });
});
