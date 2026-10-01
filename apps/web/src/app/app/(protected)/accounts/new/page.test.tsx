import { expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ push() {} }) }));
const { default: NewAccountPage } = await import('./page');
it('offers scoped presets and reviews permissions before creating a token', () => {
  const html = renderToStaticMarkup(<NewAccountPage />);
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
