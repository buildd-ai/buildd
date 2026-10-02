import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingActionConfirm } from './LandingActionConfirm';

const props = {
  prNumber: 42,
  workspaceId: 'ws-1',
  token: 't',
  fallbackHref: '/app/tasks/t1',
};
const review = { action: 'review_on_github', label: 'Review on GitHub', hint: 'h', href: 'https://github.com/org/repo/pull/42/files' };
const retry = { action: 'retry_landing', label: 'Retry landing', hint: 'h' };

describe('LandingActionConfirm', () => {
  it('renders Review on GitHub as a link to the diff, not a button that asks the server to act', () => {
    const html = renderToStaticMarkup(<LandingActionConfirm {...props} proposed="review_on_github" options={[review]} headMoved={false} />);
    expect(html).toContain('href="https://github.com/org/repo/pull/42/files"');
    expect(html).toContain('data-testid="landing-action-primary"');
    expect(html).not.toContain('Retry landing');
    expect(html).not.toMatch(/<button[^>]*landing-action-primary/);
  });

  it('keeps a secondary retry as a button', () => {
    const html = renderToStaticMarkup(<LandingActionConfirm {...props} proposed="review_on_github" options={[review, retry]} headMoved={false} />);
    expect(html).toMatch(/<button[^>]*landing-action-retry_landing/);
  });

  it('offers a re-run once new commits arrive, even on a GitHub-only page', () => {
    const html = renderToStaticMarkup(<LandingActionConfirm {...props} proposed="review_on_github" options={[review]} headMoved />);
    expect(html).toMatch(/<button[^>]*landing-action-primary[^>]*>Re-run landing/);
  });
});
