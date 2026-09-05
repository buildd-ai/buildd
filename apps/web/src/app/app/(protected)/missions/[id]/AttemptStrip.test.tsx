import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import AttemptStrip from './AttemptStrip';
import { buildAttemptStrips, type AttemptSourceTask } from '@/lib/attempt-strip';

/**
 * U8 — the attempt strip renders on the parent task's row.
 *
 * The fixture is fed through `buildAttemptStrips`, not hand-built, so the test
 * covers the assembled shape the page actually passes down.
 */

const MISSION: AttemptSourceTask[] = [
  { id: 'w1', status: 'completed', taskClass: 'work', parentTaskId: null },
  {
    id: 'a1', status: 'failed', taskClass: 'attempt', parentTaskId: 'w1',
    ciRetryPrNumber: 1204, createdAt: '2025-01-01T01:00:00Z',
    context: { iteration: 1, maxIterations: 3, failureContext: { errorType: 'ci_failure' } },
  },
  {
    id: 'a2', status: 'failed', taskClass: 'attempt', parentTaskId: 'w1',
    ciRetryPrNumber: 1204, createdAt: '2025-01-01T02:00:00Z',
    context: { iteration: 2, maxIterations: 3, failureContext: { errorType: 'ci_failure' } },
  },
  {
    id: 'a3', status: 'in_progress', taskClass: 'attempt', parentTaskId: 'w1',
    reviewerRetryPrNumber: 1204, createdAt: '2025-01-01T03:00:00Z',
    context: { iteration: 1, maxIterations: 2, failureContext: { errorType: 'reviewer_request_changes' } },
  },
];

const strip = buildAttemptStrips(MISSION, { repoFullName: 'buildd-ai/buildd' }).get('w1')!;

describe('AttemptStrip — collapsed', () => {
  const html = renderToStaticMarkup(<AttemptStrip strip={strip} />);

  it('renders the dots and the summary as one line', () => {
    expect(html).toContain('●●○');
    expect(html).toContain('3 attempts · CI ×2 · reviewer ×1');
  });

  it('is a button, so it can expand in place rather than navigate away', () => {
    expect(html).toContain('<button');
    expect(html).not.toContain('<a href="/app/tasks/a1"');
  });

  it('keeps the per-attempt reasons out of the collapsed state', () => {
    expect(html).not.toContain('CI retry #1 of 3');
  });
});

describe('AttemptStrip — expanded', () => {
  const html = renderToStaticMarkup(<AttemptStrip strip={strip} defaultExpanded />);

  it('states why each attempt exists', () => {
    expect(html).toContain('CI retry #1 of 3 · PR #1204 check_suite failed');
    expect(html).toContain('CI retry #2 of 3 · PR #1204 check_suite failed');
    expect(html).toContain('Reviewer retry #1 of 2 · PR #1204 reviewer requested changes');
  });

  it('links each attempt to its task page and its PR', () => {
    expect(html).toContain('href="/app/tasks/a1"');
    expect(html).toContain('href="https://github.com/buildd-ai/buildd/pull/1204"');
  });

  it('shows which attempt is still running', () => {
    expect(html).toContain('in_progress');
  });
});

describe('AttemptStrip — nothing to say', () => {
  it('renders no chrome for a task with no attempts', () => {
    const empty = { ...strip, total: 0, attempts: [], dots: '', summary: '0 attempts' };
    expect(renderToStaticMarkup(<AttemptStrip strip={empty} />)).toBe('');
  });

  it('renders nothing at all when no strip is passed', () => {
    expect(renderToStaticMarkup(<AttemptStrip strip={null} />)).toBe('');
  });
});

// ─── Wiring: the strip must reach the task row, and the footer must shed it ──

describe('mission detail wiring', () => {
  const dir = import.meta.dir;
  const page = readFileSync(join(dir, 'page.tsx'), 'utf8');
  const timeline = readFileSync(join(dir, 'CondensedTimeline.tsx'), 'utf8');

  it('assembles strips with the canonical grouping API, not a local regroup', () => {
    expect(page).toContain('buildAttemptStrips');
    expect(page).toMatch(/from\s+['"]@\/lib\/attempt-strip['"]/);
  });

  it('partitions the footer so attempts stop being filed as orchestrator runs', () => {
    expect(page).toContain('partitionBookkeeping');
    // The old blanket predicate treated every non-work task as footer material.
    expect(page).not.toMatch(/const isBookkeeping\s*=.*taskClass\s*!==\s*'work'/);
  });

  it('mounts the strip inside the timeline task row', () => {
    expect(timeline).toContain('<AttemptStrip');
    expect(timeline).toMatch(/attempts\??\s*:\s*AttemptStrip/);
  });
});
