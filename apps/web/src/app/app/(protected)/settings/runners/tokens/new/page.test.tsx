import { expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ push() {} }) }));
const { default: NewRunnerTokenPage } = await import('./page');
it('offers scoped presets and reviews permissions before creating a token', () => {
  const html = renderToStaticMarkup(<NewRunnerTokenPage />);
  expect(html).toContain('CI trigger');
  // The default preset is not a host-runner token, so it must not be labelled as one.
  expect(html).toContain('Task agent');
  expect(html).toContain('buildd login');
  expect(html).toContain('Analytics reader');
  expect(html).toContain('This token can');
  expect(html).toContain('Expiry');
  expect(html).toContain('Adjust scopes');
  expect(html).not.toContain('Token Level');
});

it('is a settings page: one primary, ink selection, no back link', () => {
  const html = renderToStaticMarkup(<NewRunnerTokenPage />);
  expect(html).toContain('New runner token');
  expect(html).not.toContain('← Tokens');
  expect(html.match(/btn-primary/g)?.length).toBe(1);
  // The chosen preset is marked in ink, not the orange primary border.
  expect(html).toMatch(/data-selected="true" class="[^"]*border-l-text-primary/);
  expect(html).not.toMatch(/data-selected="true" class="[^"]*border-primary/);
  expect(html).toContain('href="/app/settings/runners"');
});
