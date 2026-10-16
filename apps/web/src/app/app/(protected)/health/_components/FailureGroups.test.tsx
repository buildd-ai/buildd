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
    expect(html.match(/data-testid="failure-group"/g)?.length).toBe(1);
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

 it('splits recurring causes and folds single occurrences without losing drill-downs', () => {
   const html = renderToStaticMarkup(<FailureGroupsSection groups={data([
     w('a', "You've hit your session limit"), w('b', "You've hit your session limit"),
     w('c', 'TypeError: x is undefined'), w('d', 'TypeError: x is undefined'),
     w('e', 'Unique failure', 'reassigned'),
   ])} headline={null} windowLabel="7d" now={NOW} />);
   expect(html).toContain('data-testid="failure-kind-platform"');
   expect(html).toContain('data-testid="failure-kind-work"');
   expect(html).toContain('1 one-off failure');
   expect(html.match(/data-testid="failure-group"/g)?.length).toBe(2);
   expect(html).not.toContain('Unique failure');
 });

describe('Failures for an outside reader', () => {
  it('keeps work that already landed out of the list, with one quiet line', () => {
    const html = renderToStaticMarkup(<FailureGroupsSection groups={data([
      w('a', 'Superseded — review cancelled · already merged', 'condition_unmet'),
      w('b', 'Superseded — fix cancelled · already merged', 'condition_unmet'),
      w('c', 'TypeError: x is undefined'),
    ])} headline={{ failureRatePct: 3, failed: 1, terminal: 30 }} windowLabel="7d" now={NOW} />);
    expect(html).not.toContain('Superseded');
    expect(html).toContain('2 stopped because the work already landed');
    expect(html.match(/data-testid="failure-group"/g)?.length ?? 0).toBe(0);
  });

  it("shows a platform cause's incident state as a link, with no button to report it", () => {
    const groups = { ...buildFailureGroups({
      failures: [w('a', 'Stale worker expired (no update for 30+ minutes)', 'infra_failure'), w('b', 'Stale worker expired (no update for 30+ minutes)', 'infra_failure')],
      traces: [],
      incidents: [{ id: 'inc-1', line: 'buildd is fixing this', resolved: false, workerIds: ['a'], taskIds: [], lastSeenAt: at(1) }],
    }), truncated: false };
    const html = renderToStaticMarkup(<FailureGroupsSection groups={groups} headline={null} windowLabel="7d" now={NOW} />);
    expect(html).toContain('href="/app/incidents/inc-1"');
    expect(html).toContain('buildd is fixing this');
    expect(html).not.toContain('<button type="button" data-testid="file');
    expect(html).not.toMatch(/file with buildd|report to buildd/i);
  });

  it("gives a task cause its one line on what to do, in the row", () => {
    const html = renderToStaticMarkup(<FailureGroupsSection groups={data([w('a', 'x', 'output_unmet'), w('b', 'y', 'output_unmet')])} headline={null} windowLabel="7d" now={NOW} />);
    expect(html).toContain('data-testid="failure-group-todo"');
    expect(html).toContain('The task needed a PR or an artifact');
  });

  it('never shows a raw error string as a row heading', () => {
    const html = renderToStaticMarkup(<FailureGroupsSection groups={data([
      w('a', 'Credential lookup failed for secret 0b5e9a12 while refreshing the token for this team'),
      w('b', 'Credential lookup failed for secret 77aa1234 while refreshing the token for this team'),
    ])} headline={null} windowLabel="7d" now={NOW} />);
    expect(html).not.toContain('Credential lookup');
    expect(html).not.toContain('…');
  });
});
