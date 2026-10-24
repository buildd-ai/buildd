/**
 * Workspace limit removal from Health › Queue (spec "Parallelism limits" 0dc7c6de, R-2; AC-2).
 *
 * The Health Queue feature (PR #5534) was merged to the mission branch but not
 * yet to dev. Once it merges to dev, this test file will verify the component
 * does not show workspace_cap or workspace_paused in:
 *
 * - Waiting reason badges (currently: Declared, Lane, Limit)
 * - Limit tile sub-labels
 * - Lane panel labels
 * - Force start overrideable types
 *
 * The implementation is already correct: PR #5534 was created after workspace
 * cap removal merged (refactor 5bdf95320), so the QueueBoard component has no
 * workspace limit references. These tests document what to verify once the
 * component arrives on dev.
 */

describe.skip('Health › Queue: workspace limit removal (waiting for Health Queue feature to merge to dev)', () => {
  it('placeholder: delete and implement tests once PR #5534 merges to dev', () => {
    throw new Error('Implement tests verifying QueueBoard does not render workspace limits');
  });
});
