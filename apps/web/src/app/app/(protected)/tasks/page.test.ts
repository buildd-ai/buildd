import { describe, it, expect } from 'bun:test';

// Logic extracted from page.tsx: narrow team workspace IDs to a single
// workspace when a workspace filter is selected via ?workspace=<id>.
// The filter is only applied when the selected workspace belongs to the team
// (wsFilter must be in teamWsIds) to prevent cross-team data exposure.
function resolveQueryWorkspaceIds(
  teamWsIds: string[],
  wsFilter: string | null | undefined,
): string[] {
  return wsFilter && teamWsIds.includes(wsFilter) ? [wsFilter] : teamWsIds;
}

describe('resolveQueryWorkspaceIds', () => {
  it('returns all team workspace IDs when no filter is set', () => {
    const result = resolveQueryWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], null);
    expect(result).toEqual(['ws-1', 'ws-2', 'ws-3']);
  });

  it('narrows to the selected workspace when filter is a valid team workspace', () => {
    const result = resolveQueryWorkspaceIds(['ws-1', 'ws-2', 'ws-3'], 'ws-2');
    expect(result).toEqual(['ws-2']);
  });

  it('ignores a filter that is not in the team workspace list (prevents cross-team exposure)', () => {
    const result = resolveQueryWorkspaceIds(['ws-1', 'ws-2'], 'ws-other-team');
    expect(result).toEqual(['ws-1', 'ws-2']);
  });

  it('returns all workspaces when filter is undefined', () => {
    const result = resolveQueryWorkspaceIds(['ws-1'], undefined);
    expect(result).toEqual(['ws-1']);
  });

  it('returns empty array when team has no workspaces', () => {
    const result = resolveQueryWorkspaceIds([], null);
    expect(result).toEqual([]);
  });

  it('handles single-workspace team with matching filter', () => {
    const result = resolveQueryWorkspaceIds(['ws-solo'], 'ws-solo');
    expect(result).toEqual(['ws-solo']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mission-budget signal must reach the LIST surfaces, not just the detail page.
//
// `deriveStage` already understands `isMissionBudgetExhausted` (StageChip.test.tsx
// pins the derivation). The failure this guards is the plumbing: the flag is
// derived from `missions.status`, and this page selects mission columns
// EXPLICITLY. A missing `status` column reads as `undefined`, the flag computes
// to `false`, and an unclaimable task renders as a healthy QUEUED row again —
// the exact failure mode behind the 5-day and 24-day production strandings.
//
// Asserted against the module source rather than by importing the page: it is a
// server component that pulls in the DB client, drizzle and team-access, and a
// re-derivation of the mapping in the test file would prove nothing about the
// page (a copied predicate cannot go stale in lockstep with the original).
// Same rationale as lib/required-connectors.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const pageSource = await Bun.file(new URL('./page.tsx', import.meta.url)).text();
const gridSource = await Bun.file(new URL('./TaskGrid.tsx', import.meta.url)).text();
const cardSource = await Bun.file(
  new URL('../../../../components/TaskCard.tsx', import.meta.url),
).text();

describe('mission-budget plumbing — tasks/page.tsx', () => {
  it('selects missions.status so the flag is not silently undefined', () => {
    const missionQuery = pageSource.slice(
      pageSource.indexOf('const misns = await db.query.missions.findMany'),
      pageSource.indexOf('// Query active workers'),
    );
    expect(missionQuery.length).toBeGreaterThan(0);
    expect(missionQuery).toContain('status: true');
  });

  it('computes missionBudgetExhausted on every grid row', () => {
    expect(pageSource).toContain('missionBudgetExhausted:');
  });

  it('declares missionBudgetExhausted on the gridTasks row type', () => {
    const rowType = pageSource.slice(
      pageSource.indexOf('let gridTasks: Array<{'),
      pageSource.indexOf('}> = [];'),
    );
    expect(rowType).toContain('missionBudgetExhausted');
  });

  it('honours the operator bypass so a force-started task is not re-flagged', () => {
    // /start writes context.bypassMissionBudget on forceOverride; the claim loop
    // then claims the task. Rendering it as BUDGET EXHAUSTED would contradict
    // the gate that is actually in force.
    expect(pageSource).toContain('BYPASS_MISSION_BUDGET_KEY');
    expect(pageSource).toContain('hasBypassFlag');
  });
});

describe('mission-budget plumbing — TaskGrid.tsx', () => {
  it('declares missionBudgetExhausted on GridTask', () => {
    const gridTaskType = gridSource.slice(
      gridSource.indexOf('subjectDead?: boolean;'),
    );
    expect(gridSource).toContain('missionBudgetExhausted?: boolean;');
    expect(gridTaskType.length).toBeGreaterThan(0);
  });

  it('forwards missionBudgetExhausted to TaskCard (follows subjectDead exactly)', () => {
    const renderer = gridSource.slice(
      gridSource.indexOf('function renderTaskCard('),
      gridSource.indexOf('function renderTaskWithChildren('),
    );
    expect(renderer).toContain('subjectDead={task.subjectDead}');
    expect(renderer).toContain('missionBudgetExhausted={task.missionBudgetExhausted}');
  });

  it('counts a budget-exhausted task as BLOCKED in the stage bar, never QUEUED', () => {
    const deriver = gridSource.slice(
      gridSource.indexOf('function deriveGridTaskStage('),
      gridSource.indexOf('function computeStageCounts('),
    );
    expect(deriver).toContain('task.missionBudgetExhausted');
    // Must be inside the pending/assigned branch, ahead of the QUEUED return.
    const pendingBranch = deriver.slice(deriver.indexOf("task.status === 'pending'"));
    expect(pendingBranch.indexOf('missionBudgetExhausted')).toBeLessThan(
      pendingBranch.indexOf("return 'QUEUED'"),
    );
  });
});

describe('mission-budget plumbing — TaskCard.tsx', () => {
  it('accepts the prop and feeds it to deriveStage', () => {
    expect(cardSource).toContain('missionBudgetExhausted?: boolean;');
    const stageCall = cardSource.slice(
      cardSource.indexOf('const stage = stageOverride ?? deriveStage({'),
      cardSource.indexOf('const timestampLabel'),
    );
    expect(stageCall).toContain('isSubjectDead: subjectDead');
    expect(stageCall).toContain('isMissionBudgetExhausted: missionBudgetExhausted');
  });
});
