/**
 * BLOCKER: This test file documents the work needed to remove workspace limit
 * from Health › Queue once PR #5534 (Health Queue feature) merges to dev.
 *
 * STATUS: Waiting for prerequisite PR #5534 to merge to origin/dev.
 * Once merged, complete the following:
 *
 * 1. Implement tests for Health › Queue waiting reasons:
 *    - Verify mission_cap limit shows with Force start button
 *    - Verify runner_slots limit shows with Force start button
 *    - Verify provider_walls limit shows with Force start button
 *    - Verify workspace_cap limit is REMOVED (not shown, no tile, no lane label)
 *    - Verify Force start is NOT available for workspace_cap
 *
 * 2. Update health/QueueSection.tsx (once it exists):
 *    - Remove workspace_cap from LIMIT_LABEL dictionary
 *    - Remove workspace_paused from LIMIT_LABEL dictionary
 *    - Remove workspace_cap Force start handling
 *    - Update default cases to use mission_cap as fallback
 *    - Verify queue tiles, lane labels, and Force start match phone/desktop designs
 *
 * 3. Verify with phone- and desktop-width screenshots (visual-review skill):
 *    - No workspace limit reason shown
 *    - Force start only appears for mission_cap, runner_slots, provider_walls
 *    - Layout matches design on both viewports
 *
 * Related spec: Parallelism limits (0dc7c6de), Health › Queue (revision 2)
 * Related task: Fix the review findings on PR #5625 (round 2)
 * Related review findings:
 *   - PR adds queue-wait.ts wholesale instead of editing health Queue code
 *   - No changes under health/ for workspace limit removal
 */

// This file is a placeholder for blocking condition documentation.
// Delete this file and implement real tests once PR #5534 merges to dev.
describe.skip('Health › Queue: workspace cap removal (BLOCKED on PR #5534)', () => {
  // Placeholder to be implemented after Health Queue feature merges to dev
  it('placeholder', () => {
    throw new Error(
      'Health Queue feature (PR #5534) must merge to dev before these tests can be implemented'
    );
  });
});
