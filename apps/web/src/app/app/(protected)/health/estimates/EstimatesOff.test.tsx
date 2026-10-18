import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EstimatesOff } from './EstimatesOff';
import { isEstimatesFixtureState } from './estimates-fixtures';

describe('EstimatesOff', () => {
  test('all team roles get an honest unavailable state without settings management', () => {
    for (const canManage of [true, false]) {
      const html = renderToStaticMarkup(<EstimatesOff canManage={canManage} />);
      expect(html).toContain('Estimates are unavailable for this team.');
      expect(html).not.toMatch(/href=|Settings|turn.on|owner or admin/i);
    }
  });
  test('both legacy off states remain auditable fixtures', () => {
    expect(isEstimatesFixtureState('off-admin')).toBe(true);
    expect(isEstimatesFixtureState('off-member')).toBe(true);
  });
});
