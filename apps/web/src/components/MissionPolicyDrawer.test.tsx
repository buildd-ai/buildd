import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionPolicyDrawer from './MissionPolicyDrawer';

const render = (initialPolicy: Parameters<typeof MissionPolicyDrawer>[0]['initialPolicy']) =>
  renderToStaticMarkup(
    <MissionPolicyDrawer
      missionId="m-1"
      missionTitle="Mission"
      roles={[{ slug: 'reviewer', name: 'Reviewer' }]}
      initialPolicy={initialPolicy}
      onSave={() => {}}
      onCancel={() => {}}
    />,
  );

describe('MissionPolicyDrawer — no hand-typed paths', () => {
  it('offers no path inputs for auto-threshold or agent-review', () => {
    for (const html of [
      render({ tier: 'auto-threshold', threshold: { maxLines: 500 } }),
      render({ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } }),
    ]) {
      expect(html).not.toMatch(/Deny paths|Escalate to human for paths|placeholder="e\.g\. drizzle\/"/);
      expect(html).toContain('data-testid="mission-policy-detected-paths-note"');
    }
  });
});
