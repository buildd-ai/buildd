/**
 * Missions portfolio: compact rows from the shared delivery projection,
 * counters with definitions, search/sort/filters and collapsed completed
 * history (docs/prototypes/cross-surface-delivery, `#missions`). Fixtures are
 * illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from '@/lib/delivery-projection';
import { DoneRow, MissionGrid, type PortfolioRow } from './MissionGrid';

const NOW = Date.UTC(2026, 9, 8, 12);
const PR = 'https://github.com/o/r/pull/1';

function task(id: string, over: Partial<MissionTaskRow> = {}): MissionTaskRow {
  return { id, title: `feat: ${id}`, status: 'pending', taskClass: 'work', workers: [], ...over };
}
const landed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01', prLifecycleStatus: 'merged' }] });
const building = (id: string) => task(id, { status: 'in_progress', workers: [{ status: 'running' }] });
const inAudit = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_pending' }] });
// Closed unmerged, and the supersession scan already ran: a person decides.
const closed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed', supersessionScan: { scannedAt: '2026-10-08T10:00:00Z', suggestion: null } }] });
// Closed unmerged, scan still owed: Buildd is reconciling it.
const reconciling = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed' }] });

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
    strip: tasks.length > 0 ? tasks.map(() => 'landed' as const) : [],
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
  row('m12', 'Mobile Home as an inbox', [landed('a'), landed('b')]),
];
const done: PortfolioRow[] = [
  row('d1', 'Workspace settings split into tabs', [landed('a')], { status: 'completed', completedAt: NOW - 86_400_000 }),
  row('d2', 'CLI login without a browser', [landed('a')], { status: 'completed', completedAt: NOW - 30 * 86_400_000 }),
];

const html = renderToStaticMarkup(
  <MissionGrid
    rows={[...open, ...done]}
    slots={{ live: 1, max: 4 }}
    now={NOW}
  />,
);
const rowHtml = (id: string) => {
  const at = html.indexOf(`data-mission-id="${id}"`);
  return html.slice(at, html.indexOf('data-testid="portfolio-row"', at + 1) > 0 ? html.indexOf('data-testid="portfolio-row"', at + 1) : at + 4000);
};

describe('MissionGrid portfolio', () => {
  it('renders one row per open mission still moving or waiting; completed and on-dev ones collapsed', () => {
    expect(html.match(/data-testid="portfolio-row"/g)?.length).toBe(11);
    const history = html.match(/<section[^>]*data-group="completed"[\s\S]*?<\/section>/)![0];
    expect(history).toContain('Completed this week');
    expect(history).toContain('aria-expanded="false"');
    // Collapsed: the rows mount when it opens.
    expect(history).not.toContain('Workspace settings split into tabs');
  });

  it('groups open missions into Needs you / In motion / Waiting, each with its ordering named', () => {
    const sec = (k: string) => html.match(new RegExp(`<section[^>]*data-section="${k}"[\\s\\S]*?</section>`))![0];
    expect(sec('needs')).toContain('Needs you');
    expect(sec('needs')).toContain('oldest first');
    expect(sec('motion')).toContain('In motion');
    expect(sec('motion')).toContain('slipping first');
    expect(sec('waiting')).toContain('Waiting');
    expect(sec('waiting')).toContain('next to start first');
    const ids = (k: string) => [...sec(k).matchAll(/data-mission-id="(m\d+)"/g)].map(m => m[1]);
    expect(ids('needs')).toEqual(['m03']); // not landed
    expect(ids('motion')).toContain('m01');
    expect(ids('motion')).not.toContain('m12');
    expect(ids('waiting').indexOf('m04')).toBeLessThan(ids('waiting').indexOf('m05')); // waiting before held
  });

  it('folds missions whose every task landed into one collapsed On dev, criteria pending group', () => {
    const group = html.match(/<section[^>]*data-section="landed"[\s\S]*?<\/section>/)![0];
    expect(group).toContain('On dev, criteria pending');
    expect(group).toContain('aria-expanded="false"');
    expect(group).toContain('a goal criterion');
    // Collapsed: its rows mount only when opened.
    expect(group).not.toContain('data-mission-id="m12"');
  });

  it('drops the per-section destinations sentence', () => {
    expect(html).not.toContain('mission-section-destinations');
    expect(html).not.toContain('landing on trunk');
  });

  it('heads the page with one open count and one breakdown line, not a boxed counter grid', () => {
    expect(html).not.toContain('portfolio-counters');
    expect(html).toMatch(/data-testid="portfolio-open"[^>]*>12</);
    const line = html.match(/<p[^>]*data-testid="portfolio-breakdown"[^>]*>([\s\S]*?)<\/p>/)![1];
    expect(line).toContain('1 needs you');
    expect(line).toContain('in motion');
    expect(line).toContain('waiting');
    expect(line).toContain('1 on dev, criteria pending');
    expect(line).toContain('1 of 4 agent slots');
  });

  it('explains its words once, in a quiet footnote at the end', () => {
    expect(html).toContain('data-testid="portfolio-definitions"');
    expect(html.indexOf('portfolio-definitions')).toBeGreaterThan(html.indexOf('data-group="completed"'));
  });

  it('shows the truthful status: live agent only on the executing mission', () => {
    expect(rowHtml('m01')).toContain('1 agent');
    expect(rowHtml('m01')).toContain('data-testid="mission-row"');
    expect(rowHtml('m02')).not.toMatch(/\d agents?\b/);
    expect(rowHtml('m02')).toContain('data-kind="audit"');
  });

  it('shows the verified landed fraction, a small task strip and the next milestone', () => {
    const r = rowHtml('m01');
    expect(r).toContain('2 of 3 landed');
    expect(r).toContain('Next');
    expect(r).toContain('role="img"'); // TaskStrip size sm
  });

  it('shows a state as glyph + word', () => {
    expect(rowHtml('m02')).toContain('Auditing');
    expect(rowHtml('m03')).toContain('Not landed');
  });

  it('a closed PR still being reconciled is In motion and reads Recovering, never Needs you', () => {
    const out = renderToStaticMarkup(<MissionGrid rows={[row('m13', 'Reconciled mission', [landed('a'), reconciling('b')])]} slots={{ live: 0, max: 4 }} now={NOW} />);
    expect(out).not.toContain('data-section="needs"');
    expect(out).toMatch(/data-section="motion"[\s\S]*data-mission-id="m13"/);
    expect(out).toContain('Recovering');
  });

  it('says a needs-you mission\'s problem once: no second exception note under the row', () => {
    const r = rowHtml('m03');
    expect(r.match(/did not land|closed without merging/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('a recurring mission names its next run', () => {
    expect(rowHtml('m11')).toContain('next run in 9m');
  });

  it('filters are the sections, as one segmented control with counts', () => {
    expect(html).toContain('data-testid="portfolio-search"');
    const filters = html.match(/<div[^>]*data-testid="portfolio-filters"[\s\S]*?<\/div>/)![0];
    expect(filters).toContain('data-testid="segmented"');
    expect(filters).toContain('role="radiogroup"');
    for (const label of ['All', 'Needs you', 'In motion', 'Waiting', 'On dev']) expect(filters).toContain(label);
    expect(filters).not.toContain('Executing');
  });

  it('has no in-page workspace select: the shell switcher already scopes the page', () => {
    expect(html).not.toContain('portfolio-workspace');
    expect(html).not.toContain('All workspaces');
    expect(html).not.toMatch(/<(select|datalist)\b/);
  });

  it('the search field is a quiet hairline input, not a 2px mono box', () => {
    const input = html.match(/<input[^>]*data-testid="portfolio-search"[^>]*>/)![0];
    expect(input).not.toContain('border-2');
    expect(input).not.toContain('font-mono');
  });

  it('is one column on phones and two from md', () => {
    const grid = html.match(/<div class="[^"]*grid-cols-1[^"]*md:grid-cols-2[^"]*"/);
    expect(grid).not.toBeNull();
  });

  it('carries no release footer box: releases live on their own page', () => {
    expect(html).not.toContain('workspace-release-footer');
  });

  it('completed rows are hairline rows, not stripe cards', () => {
    const one = renderToStaticMarkup(<DoneRow row={done[0]} now={NOW} />);
    const doneRow = one.match(/<div[^>]*data-testid="portfolio-done-row"[^>]*>/)![0];
    expect(one).toContain('Workspace settings split into tabs');
    expect(doneRow).not.toContain('border-l-4');
    expect(doneRow).not.toContain('bg-card');
  });

  it('links nothing straight to a task page, uses no raw colours and no all-caps', () => {
    expect(html).not.toContain('/app/tasks/');
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(html).not.toMatch(/\buppercase\b/);
  });
});

describe('MissionGrid — empty', () => {
  it('says so in a plain sentence when nothing is open', () => {
    const html = renderToStaticMarkup(<MissionGrid rows={done} slots={{ live: 0, max: 4 }} now={NOW} />);
    expect(html).toContain('No open missions.');
    const empty = html.match(/<p[^>]*data-testid="portfolio-empty"[^>]*>/)![0];
    expect(empty).not.toContain('border');
  });
});
