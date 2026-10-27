import { describe, it, expect } from 'bun:test';

/**
 * Tests for aging out old closed-unmerged PRs from `explain` surfaces.
 *
 * A closed-unmerged PR on a task that is terminal and belongs to no open mission
 * stops counting as `pr_closed_unmerged` in explain after N days (default 14).
 *
 * It stays visible in history but is not listed in the waiting/attention surfaces.
 * This is a read-side rule: no write is needed.
 */

describe('Age out closed PRs from explain', () => {
  it('excludes a closed PR on a terminal non-mission task from explain after 14 days', async () => {
    // Task: status='completed', no missionId
    // Worker: prLifecycleStatus='closed', mergedAt=null, abandonedAt=null, supersededByPrNumber=null
    // closedAt was 15 days ago
    // Expected: not returned by explain as a waiting subject

    expect.todo('implement age-based filtering in explain for closed PRs');
  });

  it('includes a closed PR on a terminal non-mission task before 14 days in explain', async () => {
    // Task: status='completed', no missionId
    // Worker: prLifecycleStatus='closed', mergedAt=null, abandonedAt=null, supersededByPrNumber=null
    // closedAt was 13 days ago
    // Expected: returned by explain as a waiting subject (pr_closed_unmerged)

    expect.todo('implement age-based filtering in explain for closed PRs');
  });

  it('always includes a closed PR on a task in an open mission, regardless of age', async () => {
    // Task: status='completed', missionId='m-1' (mission is in open/running status)
    // Worker: prLifecycleStatus='closed', mergedAt=null, abandonedAt=null, supersededByPrNumber=null
    // closedAt was 30 days ago
    // Expected: returned by explain as a waiting subject (mission completion still needs it answered)

    expect.todo('implement age-based filtering in explain for closed PRs');
  });
});
