'use client';

/**
 * `?state=tool-breakdown`: Health's tool list with fixture counts. The real
 * list sits on the Operator page, which a screenshot account can't open, and
 * its rows start collapsed. Top to bottom: the list collapsed, then the same
 * list with every breakdown open.
 */
import ToolBreakdownList from '../../(protected)/health/_components/ToolBreakdownList';
import { buildToolBreakdown } from '@/lib/tool-usage-breakdown';

const TOTAL = 38_000;
const tool = (name: string, calls: number) => ({ name, calls, share: calls / TOTAL, tasks: 1, exactCalls: calls, exactTasks: 1 });

const ROWS = buildToolBreakdown({
  tools: [
    tool('Bash', 24_700), tool('Read', 3_900),
    // One buildd row: group tool calls fold in with the legacy tool's.
    tool('mcp__buildd__buildd_work', 2_400), tool('mcp__buildd__buildd', 1_040), tool('mcp__buildd__buildd_tasks', 300),
    tool('Edit', 2_300), tool('ToolSearch', 900), tool('Write', 600),
  ],
  bashBuckets: {
    histogramTasks: 600, classifiedTasks: 600, bashCalls: 24_700, classifiedCalls: 23_900,
    buckets: [
      { key: 'git', calls: 7_100, share: 7_100 / 23_900 },
      { key: 'file_read', calls: 5_200, share: 5_200 / 23_900 },
      { key: 'code_search', calls: 4_400, share: 4_400 / 23_900 },
      { key: 'test', calls: 3_100, share: 3_100 / 23_900 },
      { key: 'build', calls: 1_900, share: 1_900 / 23_900 },
      { key: 'gh', calls: 1_200, share: 1_200 / 23_900 },
      { key: 'file_find', calls: 600, share: 600 / 23_900 },
      { key: 'other', calls: 400, share: 400 / 23_900 },
    ],
  },
  actions: {
    totalCalls: 3_600,
    actions: [
      { action: 'update_progress', calls: 1_400 }, { action: 'get_task', calls: 600 },
      { action: 'complete_task', calls: 500 }, { action: 'create_pr', calls: 450 },
      { action: 'claim_task', calls: 350 }, { action: 'create_task', calls: 300 },
    ],
  },
  fileAreas: {
    Read: { 'apps/web': 1_800, 'apps/runner': 900, 'packages/core': 700, docs: 300, '(outside the repo)': 200 },
    Edit: { 'apps/web': 1_300, 'apps/runner': 500, 'packages/core': 400, docs: 100 },
    Write: { 'apps/web': 300, docs: 200, '(outside the repo)': 100 },
  },
});

const MAX = Math.max(...ROWS.map(r => r.calls));

export default function ToolBreakdownFixture() {
  return (
    <div className="min-h-screen bg-surface-1 p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <section className="card p-4 space-y-3">
          <h2 className="section-label">Top tools</h2>
          <ToolBreakdownList rows={ROWS} maxCalls={MAX} />
        </section>
        <section className="card p-4 space-y-3">
          <h2 className="section-label">Top tools, every breakdown open</h2>
          <ToolBreakdownList rows={ROWS} maxCalls={MAX} openAll />
        </section>
      </div>
    </div>
  );
}
