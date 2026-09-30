import { expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
const { default: RunnerTokensSection } = await import('./RunnerTokensSection');
const account = {
  id: 'fixture-token', name: 'Analytics client', type: 'service', authType: 'api',
  apiKeyPrefix: 'bld_fixture', maxConcurrentWorkers: 1, totalTasks: 0, totalCost: '0',
  activeSessions: null, maxConcurrentSessions: null, budgetExhaustedAt: null,
  budgetResetsAt: null, team: null,
};
it('shows an unused token and an expired token in the collapsed list', () => {
  const html = renderToStaticMarkup(<RunnerTokensSection accounts={[{ ...account, expiresAt: '2000-01-01T00:00:00Z' }]} />);
  expect(html).toContain('Last used: Never');
  expect(html).toContain('Expired');
});
it('shows last-used time in the collapsed list', () => {
  const usedAt = new Date('2026-01-15T12:00:00Z');
  const html = renderToStaticMarkup(<RunnerTokensSection accounts={[{ ...account, lastUsedAt: usedAt }]} />);
  expect(html).toContain(usedAt.toLocaleString());
  expect(html).not.toContain('Last used: Never');
});

it('keeps capability detail out of the compact token row', () => {
  const html = renderToStaticMarkup(<RunnerTokensSection accounts={[{...account,scopes:['analytics:read']}]} />);
  expect(html).toContain('Analytics client');
  expect(html).not.toContain('Capabilities');
});
