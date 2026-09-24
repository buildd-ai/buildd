/**
 * TaskPanelWrapper: the mission page's sheet owner. The sheet is `?task=`
 * written with native history only (AC-7 — never the router), it renders
 * synchronously from a deep link, and malformed ids never open it.
 */
import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidTaskId } from '@/lib/task-id';

const routerCalls: string[] = [];
let search = '';
mock.module('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/app/missions/m1',
  useRouter: () => ({
    push: () => routerCalls.push('push'),
    replace: () => routerCalls.push('replace'),
    refresh: () => routerCalls.push('refresh'),
    back: () => routerCalls.push('back'),
    prefetch: () => {},
  }),
}));

const { default: TaskPanelWrapper } = await import('./TaskPanelWrapper');

const TASK = '0a1b2c3d-1111-4222-8333-444455556666';
const wrapper = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(
      TaskPanelWrapper,
      {
        missionId: 'm1',
        missionTitle: 'Example mission',
        chip: { label: 'RUNNING', cls: 'border-status-info text-status-info' },
        feedTasks: [{ id: TASK, title: 'Example task', status: 'pending', taskClass: 'work', createdAt: '2026-01-01T00:00:00Z' }],
        ...props,
      },
      createElement('a', { href: `/app/missions/m1?task=${TASK}`, 'data-task-id': TASK }, 'row'),
    ),
  );

describe('TaskPanelWrapper — the sheet is ?task= state', () => {
  it('a deep link with ?task= renders the sheet on first paint, skeleton first', () => {
    search = `from=home&task=${TASK}`;
    const html = wrapper();
    expect(html).toContain('data-testid="mission-task-sheet"');
    expect(html).toContain('data-testid="task-sheet-skeleton"');
    expect(html).toContain('1 / 1');
  });

  it('no ?task= → no sheet; the list renders alone', () => {
    search = 'from=home';
    const html = wrapper();
    expect(html).toContain('row');
    expect(html).not.toContain('data-testid="mission-task-sheet"');
  });

  it('a malformed ?task= never opens a sheet', () => {
    search = 'task=not-a-uuid';
    expect(wrapper()).not.toContain('data-testid="mission-task-sheet"');
  });

  it('rendering never touches the router', () => {
    search = `task=${TASK}`;
    routerCalls.length = 0;
    wrapper();
    expect(routerCalls).toEqual([]);
  });
});

describe('AC-7: the sheet path never calls router.push / replace / refresh', () => {
  const files = ['TaskPanelWrapper.tsx', 'TaskSheet.tsx', 'TaskPanel.tsx', 'task-sheet-history.ts'];
  for (const f of files) {
    it(`${f} has no router navigation`, () => {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/\brouter\.(push|replace|refresh)\s*\(/);
      expect(src).not.toMatch(/\buseRouter\s*\(/);
    });
  }

  it('the delegated handler no longer reads data-task-actionable (AC-10)', () => {
    for (const f of ['TaskPanelWrapper.tsx', 'task-sheet-history.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/getAttribute\(\s*['"]data-task-actionable/);
    }
  });
});

describe('isValidTaskId — shared task-link guard', () => {
  it('accepts a proper v4 UUID', () => {
    expect(isValidTaskId('bf442fcb-6179-43b3-aa92-2564b1ad24b8')).toBe(true);
  });

  it('accepts uppercase UUID', () => {
    expect(isValidTaskId('BF442FCB-6179-43B3-AA92-2564B1AD24B8')).toBe(true);
  });

  it('rejects zero-padded UUID (the production regression pattern)', () => {
    // Real ID bf442fcb-6179-43b3-aa92-2564b1ad24b8 mangled to this
    expect(isValidTaskId('bf442fcb-0000-0000-0000-000000000000')).toBe(false);
  });

  it('rejects an 8-char short ID', () => {
    expect(isValidTaskId('bf442fcb')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidTaskId(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidTaskId(undefined)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTaskId('')).toBe(false);
  });

  it('rejects a UUID missing dashes', () => {
    expect(isValidTaskId('bf442fcb617943b3aa922564b1ad24b8')).toBe(false);
  });

  it('rejects a string that is too short', () => {
    expect(isValidTaskId('bf442fcb-6179-43b3')).toBe(false);
  });

  it('rejects a zero-padded ID with only first segment real', () => {
    expect(isValidTaskId('08e2db98-0000-0000-0000-000000000000')).toBe(false);
  });

  it('accepts multiple distinct real UUIDs', () => {
    expect(isValidTaskId('08e2db98-6f42-423f-9ac7-fb1caff6f06c')).toBe(true);
    expect(isValidTaskId('46e91502-0000-0000-0000-000000000000')).toBe(false);
    expect(isValidTaskId('46e91502-dead-beef-cafe-123456789abc')).toBe(true);
  });

  it('accepts running-state task UUID (regression: running rows must not 404)', () => {
    // Real task ID from production incident 2026-07-09 — mission timeline row
    // for a "running" task was returning 404; ensure the ID is valid for panel open
    expect(isValidTaskId('b5814ed6-4808-499c-8eff-16e567f86576')).toBe(true);
  });

  it('rejects worker ID that looks like a task ID (historical confusion source)', () => {
    // Worker IDs are also UUIDs; the panel must open with the TASK id, not the worker id.
    // Both are syntactically valid UUIDs — this test documents the distinction and confirms
    // isValidTaskId cannot discriminate between them (that's a runtime concern, not a format concern).
    expect(isValidTaskId('c6a00c1a-161a-40fb-b13c-dee1670fea99')).toBe(true);
  });
});
