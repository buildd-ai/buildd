/**
 * The headline's "more" toggle mounts only once the headline is clipped, so it
 * needs a DOM with a measured overflow. Runs in its own process
 * (scripts/run-unit-tests.ts), so the happy-dom globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/task-1' });

import { describe, expect, it } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const { default: NowStrip } = await import('./NowStrip');
const { deriveNow } = await import('./task-activity');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('headline more toggle', () => {
  it('is at least 44x44 below md, whatever the width of "more"', async () => {
    // happy-dom has no layout: report every paragraph as three lines clipped.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.tagName === 'P' ? 120 : 0; } });
    const now = deriveNow(
      [{ type: 'status', label: 'A long narration line', ts: 5 } as never],
      { status: 'running', currentAction: null, startMs: 0, nowMs: 20, prUrl: null, filesChanged: 0, commitCount: 0 } as never,
    );
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<NowStrip now={now} nowMs={20} />); });

    const more = el.querySelector('[data-testid="worker-now-headline-more"]');
    expect(more?.textContent).toBe('more');
    expect(more!.className.split(' ')).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11', 'md:min-h-0', 'md:min-w-0']));

    await act(async () => root.unmount());
    el.remove();
  });
});

describe('run evidence disclosure', () => {
  it('opens the labelled phase list with provenance', async () => {
    const { default: NowStrip } = await import('./NowStrip');
    const now = deriveNow([{ type:'status', progress:70, label:'Checking changes', ts:10 } as never], { status:'running', currentAction:null, startMs:0, nowMs:20, prUrl:null, filesChanged:2 } as never);
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<NowStrip now={now} nowMs={20} />); });
    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="run-evidence-rail"] button[aria-expanded]')!;
    await act(async () => { toggle.click(); });
    const items = el.querySelectorAll('[data-testid="run-evidence-list"] li[data-phase]');
    expect(items.length).toBe(now.evidence.phases.filter(p => p.state !== 'skipped').length);
    expect(el.querySelector('[data-source="reported"]')?.getAttribute('aria-label')).toBe('Changes, done, reported');
    await act(async () => root.unmount());
    el.remove();
  });
});
