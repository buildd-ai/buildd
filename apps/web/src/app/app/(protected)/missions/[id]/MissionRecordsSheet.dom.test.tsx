/**
 * MissionRecordsSheet, mounted (happy-dom) — slice S7, AC-18: the mission page
 * no longer ships artifact bodies, so the sheet fetches the bodies of the list
 * it is showing when it opens, and never before.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionRecordsSheet, idsNeedingContent, withContent } = await import('./MissionRecordsSheet');

// Illustrative fixtures only.
const artifact = (id: string, title: string) => ({
  id, type: 'report', title, content: null as string | null, shareToken: null,
  visibility: 'private' as const, metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', taskTitle: 'Example task',
});
const records = [artifact('r1', 'Example plan'), artifact('r2', 'Example review')];
const all = [...records, artifact('cap', 'Example capture')];

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

function loader(result: Record<string, string | null> | Error = {}) {
  const calls: string[][] = [];
  const fn = async (_m: string, ids: string[]) => {
    calls.push(ids);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls };
}

describe('MissionRecordsSheet lazy content (AC-18)', () => {
  it('fetches nothing while closed', async () => {
    const l = loader();
    act(() => root.render(<MissionRecordsSheet missionId="m1" baseUrl="https://example.test" records={records} allArtifacts={all} loadContent={l.fn} />));
    await flush();
    expect(l.calls).toEqual([]);
  });

  it('opening fetches the records’ bodies once; All artifacts fetches only the rest', async () => {
    const l = loader({ r1: '# Plan body', r2: 'Review body', cap: 'Capture body' });
    act(() => root.render(<MissionRecordsSheet missionId="m1" baseUrl="https://example.test" records={records} allArtifacts={all} loadContent={l.fn} />));
    act(() => { (container.querySelector('[data-testid="mission-records-row"]') as HTMLElement).click(); });
    await flush();
    expect(l.calls).toEqual([['r1', 'r2']]);

    const allButton = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.startsWith('All artifacts'))!;
    act(() => { allButton.click(); });
    await flush();
    expect(l.calls).toEqual([['r1', 'r2'], ['cap']]);
  });

  it('a failed fetch offers a retry that asks again', async () => {
    const l = loader(new Error('offline'));
    act(() => root.render(<MissionRecordsSheet missionId="m1" baseUrl="https://example.test" records={records} allArtifacts={all} loadContent={l.fn} defaultOpen />));
    await flush();
    const retry = document.querySelector('[data-testid="mission-records-retry"]') as HTMLElement;
    expect(retry).not.toBeNull();
    act(() => { retry.click(); });
    await flush();
    expect(l.calls.length).toBe(2);
  });
});

describe('idsNeedingContent / withContent', () => {
  it('asks only for bodies not yet present or fetched', () => {
    const shown = [{ ...records[0], content: 'already' }, records[1], all[2]];
    expect(idsNeedingContent(shown, { cap: null })).toEqual(['r2']);
  });

  it('fills fetched bodies and leaves the rest', () => {
    const out = withContent(records, { r1: 'body' });
    expect(out[0].content).toBe('body');
    expect(out[1]).toBe(records[1]);
  });
});
