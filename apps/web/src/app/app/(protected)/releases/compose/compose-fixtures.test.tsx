import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const { default: ReleaseFlow } = await import('./ReleaseFlow');
const { COMPOSE_FIXTURE_STATES, composeFixture, resolveComposeFixtureState } = await import('./compose-fixtures');

function render(state: (typeof COMPOSE_FIXTURE_STATES)[number]): string {
  const f = composeFixture(state);
  if (f.kind !== 'flow') throw new Error(`${state} is not a flow fixture`);
  return renderToStaticMarkup(<ReleaseFlow view={f.view} fixture={f.flowFixture} />);
}

/** The opening tag of the element carrying `testid`. */
const tag = (html: string, testid: string) => html.match(new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`))?.[0] ?? '';

describe('resolveComposeFixtureState', () => {
  it('only resolves known states on a dev server', () => {
    expect(resolveComposeFixtureState('review-failing', 'development')).toBe('review-failing');
    expect(resolveComposeFixtureState(['compose', 'x'], 'development')).toBe('compose');
    expect(resolveComposeFixtureState('bogus', 'development')).toBeNull();
    expect(resolveComposeFixtureState(undefined, 'development')).toBeNull();
    expect(resolveComposeFixtureState('compose', 'production')).toBeNull();
  });
});

describe('compose fixtures', () => {
  it('every flow state renders', () => {
    for (const s of COMPOSE_FIXTURE_STATES) {
      if (composeFixture(s).kind === 'flow') expect(render(s)).toContain('release-flow-lede');
    }
  });

  it('compose: a populated picker with an enabled cut', () => {
    const html = render('compose');
    expect(html).toContain('Ready to include');
    expect(html).toContain('Not ready');
    expect(html).toContain('>Include<');
    expect(tag(html, 'release-flow-cut')).not.toContain('disabled');
  });

  it('compose-empty: nothing to ship, the cut is disabled', () => {
    const html = render('compose-empty');
    expect(html).toContain('Nothing on dev since the last release.');
    expect(tag(html, 'release-flow-cut')).toContain('disabled');
  });

  it('confirm: the confirm card replaces the cut', () => {
    const html = render('confirm');
    expect(html).toContain('release-flow-confirm');
    expect(html).not.toContain('release-flow-cut');
  });

  it('reply-error: an error reply above the flow', () => {
    expect(render('reply-error')).toContain('release-flow-reply');
  });

  it('review-failing: failing and missing checks, release disabled', () => {
    const html = render('review-failing');
    expect(html).toContain('not run on this SHA');
    expect(html).toContain('failed');
    expect(html).toContain('not approved on this SHA');
    expect(tag(html, 'release-flow-release')).toContain('disabled');
  });

  it('review-ready: release enabled', () => {
    expect(tag(render('review-ready'), 'release-flow-release')).not.toContain('disabled');
  });

  it('review-exclude: the exclusion notice and amend button', () => {
    const html = render('review-exclude');
    expect(html).toContain('release-flow-exclusion-notice');
    expect(html).toContain('release-flow-exclude');
  });

  it('review-refused: the refusal notice', () => {
    expect(render('review-refused')).toContain('release-flow-refusal');
  });

  it('release: merged and awaiting production, mark-released disabled', () => {
    expect(tag(render('release'), 'release-flow-confirm-production')).toContain('disabled');
  });

  it('error: a page-level load error, not a flow', () => {
    expect(composeFixture('error').kind).toBe('error');
  });

  it('not-enabled: the empty state, with workspaces to link to release settings', () => {
    const f = composeFixture('not-enabled');
    expect(f.kind).toBe('not-enabled');
    if (f.kind === 'not-enabled') expect(f.workspaces.length).toBeGreaterThan(0);
  });
});
