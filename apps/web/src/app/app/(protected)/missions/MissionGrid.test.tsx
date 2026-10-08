/**
 * Missions portfolio: compact rows from the shared delivery projection,
 * counters with definitions, search/sort/filters and collapsed completed
 * history (docs/prototypes/cross-surface-delivery, `#missions`). Fixtures are
 * illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { derivedValue, derivedUnavailable } from '@buildd/core/derived-metric';
import { projectMissionDelivery, type MissionTaskRow } from '@/lib/delivery-projection';
import { MissionGrid, type PortfolioRow } from './MissionGrid';

const NOW = Date.UTC(2026, 9, 8, 12);
const PR = 'https://github.com/o/r/pull/1';

function task(id: string, over: Partial<MissionTaskRow> = {}): MissionTaskRow {
  return { id, title: `feat: ${id}`, status: 'pending', taskClass: 'work', workers: [], ...over };
}
const landed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01', prLifecycleStatus: 'merged' }] });
const building = (id: string) => task(id, { status: 'in_progress', workers: [{ status: 'running' }] });
const inAudit = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_pending' }] });
const closed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed' }] });

function row(id: string, title: string, tasks: MissionTaskRow[], over: Partial<PortfolioRow> & { isHeld?: boolean } = {}): PortfolioRow {
  const { isHeld = false, ...rest } = over;
  const status = rest.status ?? 'active';
  return {
    delivery: projectMissionDelivery({ id, title, status, href: `/app/missions/${id}`, isHeld, tasks }, missionHelpers),
    status,
    workspaceId: 'ws1',
    workspaceName: 'web',
    priority: 0,
    liveAgents: 0,
    lastAdvancedAt: NOW - 120_000,
    completedAt: null,
    nextScanMins: null,
    ...rest,
  };
}

// 11 open missions, as in the approved design, plus two completed.
const open: PortfolioRow[] = [
  row('m01', 'Billing exports: CSV and scheduled email', [landed('a'), landed('b'), building('c')], { liveAgents: 1 }),
  row('m02', 'Typo-tolerant workspace search', [landed('a'), inAudit('b'), task('c')]),
  row('m03', 'Export the audit log as CSV', [landed('a'), closed('b')]),
  row('m04', 'Runner install on arm64 Linux', [task('a'), task('b')]),
  row('m05', 'Per-team rate limits and quotas', [task('a')], { isHeld: true, status: 'paused' }),
  row('m06', 'Daily digest email', []),
  row('m07', 'Quarantine flaky integration tests', [landed('a'), inAudit('b')], { workspaceId: 'ws2', workspaceName: 'core' }),
  row('m08', 'Visual audit on preview deployments', [inAudit('a')]),
  row('m09', 'Locale-aware date formats', [landed('a'), inAudit('b')]),
  row('m10', 'API reference refresh', [task('a')]),
  row('m11', 'Keep dependencies current', [], { nextScanMins: 9 }),
];
const done: PortfolioRow[] = [
  row('d1', 'Workspace settings split into tabs', [landed('a')], { status: 'completed', completedAt: NOW - 86_400_000 }),
  row('d2', 'CLI login without a browser', [landed('a')], { status: 'completed', completedAt: NOW - 30 * 86_400_000 }),
];

const release = {
  ws1: {
    archetype: 'gated' as const,
    queueDepth: derivedValue(3),
    oldestMergedAt: derivedUnavailable<string>('no_scope'),
    baselineSource: 'healthy' as const,
    releaseId: 'rel-1',
  },
};

const html = renderToStaticMarkup(
  <MissionGrid
    rows={[...open, ...done]}
    releaseFooters={release}
    slots={{ live: 1, max: 4 }}
    workspaces={[{ id: 'ws1', name: 'web' }, { id: 'ws2', name: 'core' }]}
    now={NOW}
  />,
);
const rowHtml = (id: string) => {
  const at = html.indexOf(`data-mission-id="${id}"`);
  return html.slice(at, html.indexOf('data-testid="portfolio-row"', at + 1) > 0 ? html.indexOf('data-testid="portfolio-row"', at + 1) : at + 4000);
};

describe('MissionGrid portfolio', () => {
  it('renders one compact row per open mission, completed ones collapsed', () => {
    expect(html.match(/data-testid="portfolio-row"/g)?.length).toBe(11);
    const history = html.slice(html.indexOf('data-group="completed"'));
    expect(history.startsWith('data-group="completed"')).toBe(true);
    expect(html).toMatch(/<details[^>]*data-group="completed"/);
    expect(html).not.toMatch(/<details[^>]*data-group="completed"[^>]*\bopen\b/);
    // Only the recent one; the older one sits behind "show 1 older".
    expect(history).toContain('Workspace settings split into tabs');
    expect(history).not.toContain('CLI login without a browser');
    expect(history).toContain('show 1 older');
  });

  it('defaults to the attention order: exceptions first, waiting and held last', () => {
    const order = [...html.matchAll(/data-mission-id="(m\d+)"/g)].map(m => m[1]);
    expect(order[0]).toBe('m03'); // not landed
    expect(order.indexOf('m01')).toBeLessThan(order.indexOf('m04')); // building before waiting
    expect(order.indexOf('m04')).toBeLessThan(order.indexOf('m05')); // waiting before held
  });

  it('counters say open / executing / agent slots, each with a definition', () => {
    const counters = html.slice(html.indexOf('data-testid="portfolio-counters"'), html.indexOf('What these count'));
    expect(counters).toMatch(/data-testid="counter-open"[^>]*>.*?>11</);
    expect(counters).toMatch(/data-testid="counter-executing"[^>]*>.*?>1</);
    expect(counters).toContain('1/4');
    expect(counters).toContain('agent slots');
    expect(counters.match(/title="[^"]+"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toMatch(/\d+ running · \d+ agents? on it/);
  });

  it('shows the truthful status: live agent only on the executing mission', () => {
    expect(rowHtml('m01')).toContain('data-testid="portfolio-live"');
    expect(rowHtml('m01')).toContain('1 agent');
    expect(rowHtml('m02')).not.toContain('data-testid="portfolio-live"');
    expect(rowHtml('m02')).toContain('data-kind="audit"');
  });

  it('shows the verified landed fraction and the next milestone', () => {
    const r = rowHtml('m01');
    expect(r).toContain('2/3 landed');
    expect(r).toContain('aria-label="2 of 3 tasks landed"');
    expect(r).toMatch(/data-testid="portfolio-next"[^>]*>Next: /);
  });

  it('raises an exception line only when there is one', () => {
    expect(rowHtml('m03')).toContain('data-testid="portfolio-exception"');
    expect(rowHtml('m03')).toContain('did not land');
    expect(rowHtml('m01')).not.toContain('data-testid="portfolio-exception"');
  });

  it('a recurring mission names its next run', () => {
    expect(rowHtml('m11')).toContain('next run in 9m');
  });

  it('has search, sort, status filters with counts, and a workspace filter', () => {
    expect(html).toContain('data-testid="portfolio-search"');
    const sort = html.slice(html.indexOf('data-testid="portfolio-sort"'), html.indexOf('</select>'));
    for (const label of ['Needs attention', 'Recently advanced', 'Closest to landing', 'Priority']) expect(sort).toContain(label);
    const filter = (k: string) => html.match(new RegExp(`data-filter="${k}"[^>]*>[^<]*<span[^>]*>(\\d+)</span>`))?.[1];
    expect(filter('all')).toBe('11');
    expect(filter('executing')).toBe('1');
    expect(filter('exceptions')).toBe('1');
    expect(html).toContain('data-testid="portfolio-workspace"');
    expect(html).toContain('All workspaces');
  });

  it('desktop gets columns; phones get stacked lines', () => {
    const r = html.match(/<div[^>]*data-testid="portfolio-row"[^>]*>/)![0];
    expect(r).toContain('grid-cols-[minmax(0,1fr)_auto]');
    expect(r).toMatch(/lg:grid-cols-\[/);
    expect(html).toContain('>Status</span><span>Mission</span><span>Landed</span><span>Next</span>');
  });

  it('chips never wrap into each other, titles clamp, next truncates', () => {
    const chip = html.match(/<span[^>]*data-testid="delivery-chip"[^>]*>/)![0];
    expect(chip).toContain('whitespace-nowrap');
    expect(chip).toContain('shrink-0');
    expect(html).toContain('line-clamp-2');
    expect(html.match(/<span[^>]*data-testid="portfolio-next"[^>]*>/)![0]).toContain('truncate');
  });

  it('shows the workspace release state once, never on a row (D6)', () => {
    expect(html.match(/data-testid="workspace-release-footer"/g)?.length).toBe(1);
  });

  it('links nothing straight to a task page and uses no raw colours', () => {
    expect(html).not.toContain('/app/tasks/');
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe('MissionGrid — empty and single-workspace', () => {
  it('says so when nothing is open, and hides the workspace filter for one workspace', () => {
    const html = renderToStaticMarkup(<MissionGrid rows={done} slots={{ live: 0, max: 4 }} workspaces={[{ id: 'ws1', name: 'web' }]} now={NOW} />);
    expect(html).toContain('No open missions.');
    expect(html).not.toContain('data-testid="portfolio-workspace"');
  });
});
