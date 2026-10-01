import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  usePathname: () => '/app/home',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { default: ContinueOnRunnerCta } = await import('./ContinueOnRunnerCta');

const strand = { missionId: 'm1', quietMs: 2 * 3600_000, taskId: 't1', claimable: 1, blockedReason: null, order: 'runner-first' as const };

describe('ContinueOnRunnerCta', () => {
  it('offers Continue on a runner first, Keep local second, by default', () => {
    const html = renderToStaticMarkup(<ContinueOnRunnerCta strand={strand} />);
    expect(html).toContain('data-order="runner-first"');
    expect(html.indexOf('strand-continue-on-runner')).toBeLessThan(html.indexOf('strand-keep-local'));
    expect(html).not.toContain('strand-cta-blocked');
  });

  it('a refused flip renders the button disabled with the reason — not hidden', () => {
    const html = renderToStaticMarkup(
      <ContinueOnRunnerCta strand={{ ...strand, blockedReason: 'The mission has no workspace.' }} />,
    );
    expect(html).toContain('data-testid="strand-continue-on-runner"');
    expect(html).toMatch(/data-testid="strand-continue-on-runner"[^>]*disabled=""/);
    expect(html).toContain('data-testid="strand-cta-blocked"');
    expect(html).toContain('The mission has no workspace.');
  });

  it('local-first puts Keep local first (only a gated decision ever asks for it)', () => {
    const html = renderToStaticMarkup(<ContinueOnRunnerCta strand={strand} order="local-first" />);
    expect(html.indexOf('strand-keep-local')).toBeLessThan(html.indexOf('strand-continue-on-runner'));
  });
});
