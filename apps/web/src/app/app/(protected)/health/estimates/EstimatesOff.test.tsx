import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EstimatesOff } from './EstimatesOff';
import { isEstimatesFixtureState } from './estimates-fixtures';

describe('EstimatesOff', () => {
  test('an admin gets the way to turn it on, not a dead end', () => {
    const html = renderToStaticMarkup(<EstimatesOff canManage defaultOffReason="Not on by default yet." />);
    expect(html).toContain('Task estimates are off for this team.');
    expect(html).toContain('data-testid="estimates-turn-on"');
    expect(html).toContain('href="/app/settings/features"');
    expect(html).toContain('Not on by default yet.');
    expect(html).not.toContain('estimates-ask-admin');
  });

  test('a member learns who can turn it on, with no action of their own', () => {
    const html = renderToStaticMarkup(<EstimatesOff canManage={false} defaultOffReason={null} />);
    expect(html).toContain('data-testid="estimates-ask-admin"');
    expect(html).toContain('owner or admin');
    expect(html).not.toContain('estimates-turn-on');
  });

  test('both off states are auditable fixtures', () => {
    expect(isEstimatesFixtureState('off-admin')).toBe(true);
    expect(isEstimatesFixtureState('off-member')).toBe(true);
  });
});
