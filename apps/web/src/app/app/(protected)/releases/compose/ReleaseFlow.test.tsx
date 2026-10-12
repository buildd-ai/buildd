import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { candidateVerdict, defaultSelection, groupComposition, REQUIRED_CANDIDATE_CHECKS } from '@buildd/core/release-compose';
import type { ReleaseFlowView } from '@/lib/release/compose-source';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const { default: ReleaseFlow } = await import('./ReleaseFlow');
const { recordSentence, stepIndex } = await import('./flow-display');

const CAND = 'c'.repeat(40);

function view(over: Partial<ReleaseFlowView> = {}): ReleaseFlowView {
  const composition = groupComposition({
    shippedPrs: [
      { number: 10, title: 'Billing', url: 'https://github.com/o/r/pull/10', mergeSha: 'a'.repeat(40), missionId: 'm1' },
      { number: 11, title: 'Fix a typo', url: 'https://github.com/o/r/pull/11', mergeSha: 'b'.repeat(40), missionId: null },
    ],
    missions: [
      { id: 'm1', title: 'Billing', criteria: { met: 2, total: 3 }, missionPr: null },
      { id: 'm3', title: 'Search', criteria: null, missionPr: { number: 30, title: 'Ship Search', url: 'u30', state: 'open', approved: true, checks: 'passing' } },
    ],
  });
  return {
    workspace: { id: 'ws-1', name: 'app', repoFullName: 'o/r' },
    sourceBranch: 'dev',
    prodBranch: 'main',
    compositionSha: 'd'.repeat(40),
    composition,
    defaultSelected: [...defaultSelection(composition)],
    leftOut: [],
    candidate: null,
    merged: null,
    step: 'compose',
    lede: 'The next release would ship 1 mission, 1 other change.',
    counts: { missions: 1, other: 1 },
    record: [],
    truncated: false,
    ...over,
  };
}

const render = (v: ReleaseFlowView) => renderToStaticMarkup(<ReleaseFlow view={v} />);

describe('Compose', () => {
  const html = render(view());

  it('leads with the result and shows where the flow is', () => {
    expect(html).toContain('The next release would ship 1 mission, 1 other change.');
    expect(html).toMatch(/aria-current="step"[^>]*>Compose</);
  });

  it('lists missions on dev and other changes as checked rows, ready missions with an Include button', () => {
    expect(html).toContain('data-testid="compose-row-mission:m1"');
    expect(html).toContain('2 of 3 criteria');
    expect(html).toContain('data-testid="compose-row-pr:11"');
    expect((html.match(/type="checkbox"[^>]*checked=""/g) ?? []).length).toBe(2);
    const ready = html.slice(html.indexOf('data-testid="compose-row-mission:m3"'));
    expect(ready).toContain('>Include</button>');
    expect(ready).toContain('through the normal merge checks');
  });

  it('one primary: Cut the candidate', () => {
    expect(html).toContain('data-testid="release-flow-cut"');
    expect((html.match(/btn-primary/g) ?? []).length).toBe(1);
  });
});

describe('Review', () => {
  const pending = candidateVerdict({
    candidateSha: CAND,
    required: REQUIRED_CANDIDATE_CHECKS,
    checks: [{ name: 'build', sha: CAND, state: 'passing', url: 'https://ci/build' }],
    reviews: [{ author: 'a', state: 'APPROVED', sha: 'o'.repeat(40) }],
  });
  const cand = {
    prNumber: 99, url: 'https://github.com/o/r/pull/99', version: '1.4.0', candidateSha: CAND, sourceSha: 'd'.repeat(40),
    amendment: 1, previousCandidateSha: 'o'.repeat(40), reverted: [], verdict: pending,
    refusal: { sha: 'e'.repeat(40), files: ['src/a.ts'], candidateSha: CAND, at: '' }, deltaUrl: 'https://github.com/o/r/compare/x...y',
  };
  const html = render(view({ candidate: cand, step: 'review', lede: 'v1.4.0 is not ready.' }));

  it('shows every check on this SHA with its link, and that an earlier approval is void', () => {
    expect(html).toContain('data-testid="release-flow-check-build"');
    expect(html).toContain('href="https://ci/build"');
    expect(html).toContain('data-testid="release-flow-check-release candidate verified"');
    expect(html).toContain('not run on this SHA');
    expect(html).toContain('not approved on this SHA');
    expect(html).toContain('1 approval on an earlier SHA, void');
    expect(html).toContain('Nothing here approves the candidate');
  });

  it('shows the amendment delta and a refused exclusion with its files', () => {
    expect(html).toContain('what changed');
    expect(html).toContain('data-testid="release-flow-refusal"');
    expect(html).toContain('src/a.ts');
  });

  it('Release stays disabled until every check passed and an approval stands on this SHA', () => {
    const btn = html.match(/<button[^>]*data-testid="release-flow-release"[^>]*>/)?.[0] ?? '';
    expect(btn).toContain('disabled');
    expect(html).not.toContain('>Include</button>');
  });
});

describe('Release', () => {
  it('a merged release is not marked released until production runs it', () => {
    const html = render(view({
      step: 'release',
      merged: { prNumber: 99, url: 'u', version: '1.4.0', mergeSha: 'm'.repeat(40), mergedAt: '', deployedSha: 'x'.repeat(40), production: 'awaiting_production', confirmed: false },
    }));
    expect(html).toContain('which does not contain it yet');
    const btn = html.match(/<button[^>]*data-testid="release-flow-confirm-production"[^>]*>/)?.[0] ?? '';
    expect(btn).toContain('disabled');
  });
});

describe('record sentences name the actor', () => {
  it('reads as who did what', () => {
    const base = { id: '1', at: '2026-10-12T10:00:00Z', candidateSha: null, prNumber: null, version: null, detail: null, actor: 'Ana' };
    expect(recordSentence({ ...base, step: 'cut', outcome: 'pending', detail: { sourceSha: 'd'.repeat(40), leftOut: [{ label: 'Billing' }] } })).toBe(
      'Ana cut the candidate from dev at ddddddddd, leaving out Billing.',
    );
    expect(recordSentence({ ...base, step: 'include', outcome: 'succeeded', prNumber: 30, detail: { title: 'Search' } })).toBe('Ana merged Search (#30) into dev.');
    expect(recordSentence({ ...base, step: 'confirm_production', outcome: 'refused', version: '1.4.0', detail: { deployedSha: null } })).toBe(
      'Ana checked production for v1.4.0; production reported no SHA, so it was not marked released.',
    );
  });

  it('the step line: Cut is done once a candidate exists', () => {
    expect(stepIndex('compose')).toBe(0);
    expect(stepIndex('review')).toBe(2);
  });
});
