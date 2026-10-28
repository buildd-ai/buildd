import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClaimabilitySection } from './ClaimabilitySection';

describe('Claimability copy', () => {
  test('never mentions a workspace limit (none exists)', () => {
    for (const plans of [0, 3]) {
      const html = renderToStaticMarkup(<ClaimabilitySection now={Date.now()} health={{
        plans, mode: 'apply', lastEvaluatedAt: new Date().toISOString(), plansWithOrdering: 0, plansUnderPressure: 0,
        plansLeavingClaimableWork: 0, plansWithoutCapacity: 0, byBackend: { claude: plans, codex: 0, mixed: 0 },
      } as never} />);
      expect(html.toLowerCase()).not.toContain('workspace limit');
    }
  });
});
