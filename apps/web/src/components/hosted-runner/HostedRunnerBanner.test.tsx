import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostedRunnerBanner } from './HostedRunnerBanner';

describe('HostedRunnerBanner', () => {
  it('links to Billing and budgets, where the hosted runner month is; Usage moved to the admin app', () => {
    const html = renderToStaticMarkup(<HostedRunnerBanner level="warn" text="80% of hosted runner hours used." />);
    expect(html).toContain('href="/app/settings/billing"');
    expect(html).not.toContain('/app/health/usage');
  });
});
