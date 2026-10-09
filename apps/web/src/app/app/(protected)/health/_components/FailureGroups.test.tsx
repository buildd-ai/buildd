import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FailureGroupsSection, failureProblemLine } from './FailureGroups';
import { buildFailureGroups, type FailedWorkerInput } from '@/lib/health-failure-groups';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const w = (id: string, error: string, exitCause = 'code_failure'): FailedWorkerInput => ({
  workerId: id, taskId: `t-${id}`, taskTitle: `Task ${id}`, workspaceName: 'ws', error, exitCause, completedAt: at(1),
});

function data(failures: FailedWorkerInput[]) {
  return { ...buildFailureGroups({ failures, traces: [] }), truncated: false };
}

describe('FailureGroupsSection', () => {
  it('shows the headline rate and one row per cause, platform causes labelled', () => {
    const html = renderToStaticMarkup(
      <FailureGroupsSection
        groups={data([w('1', "You've hit your session limit · resets 3pm"), w('2', "You've hit your session limit · resets 4pm"), w('3', 'TypeError: x is undefined')])}
        headline={{ failureRatePct: 8, failed: 3, terminal: 40 }}
        windowLabel="7d"
        now={NOW}
      />,
    );
    expect(html).toContain('8%');
    expect(html).toContain('3 of 40 agent runs failed');
    expect(html.match(/data-testid="failure-group"/g)?.length).toBe(2);
    expect(html).toContain("Hit the model provider&#x27;s usage limit");
    expect(html).toContain('Platform');
  });

  it('says nothing failed instead of rendering an empty list', () => {
    const html = renderToStaticMarkup(<FailureGroupsSection groups={data([])} headline={{ failureRatePct: 0, failed: 0, terminal: 10 }} windowLabel="7d" now={NOW} />);
    expect(html).toContain('Nothing failed in this window.');
  });

  it('explains when it could not load, rather than claiming nothing failed', () => {
    const html = renderToStaticMarkup(<FailureGroupsSection groups={null} headline={null} windowLabel="7d" now={NOW} />);
    expect(html).toContain("couldn&#x27;t be loaded");
  });
});

describe('failureProblemLine', () => {
  it('counts the causes and names the biggest one', () => {
    const failures = [w('a', "You've hit your session limit · resets 3pm"), w('b', "You've hit your session limit · resets 4pm"), w('c', 'TypeError: x is undefined')];
    const line = failureProblemLine(data(failures), '7d');
    expect(line).toStartWith('Failures: 2 causes this week, mostly ');
    expect(line).toContain("hit the model provider's usage limit");
  });

  it('one cause reads as one, in the window it was counted in', () => {
    expect(failureProblemLine(data([w('a', 'TypeError: x is undefined')]), '24h')).toStartWith('Failures: 1 cause in the last day: ');
  });
});
