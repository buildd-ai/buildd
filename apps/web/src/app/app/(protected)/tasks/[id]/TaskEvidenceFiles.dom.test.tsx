/**
 * The task page's Evidence files section in a browser (happy-dom): the object
 * list, the tail viewer with grep, "load more", a grep refusal shown inline,
 * the empty state and the per-click download. Network goes through a stub
 * transport. Runs in its own process (scripts/run-unit-tests.ts).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { describe, expect, it, mock } from 'bun:test';
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
import type { EvidenceObjectSummary, TaskEvidenceReadResponse } from '@buildd/shared';
import type { EvidenceTransport, TransportResult } from './task-evidence-files';

const { default: TaskEvidenceFiles } = await import('./TaskEvidenceFiles');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TASK = 'task-1';
const obj = (over: Partial<EvidenceObjectSummary> = {}): EvidenceObjectSummary => ({
  id: 'ev-1', workspaceId: 'ws', taskId: TASK, rootTaskId: TASK, workerId: 'w', prNumber: null,
  kind: 'command_output', bytes: 20 * 1024, uploadState: 'stored', indexState: 'indexed',
  createdAt: '2026-09-30T14:02:00.000Z', expiresAt: null, ...over,
});

const readBody = (over: Partial<TaskEvidenceReadResponse> = {}): TaskEvidenceReadResponse => ({
  taskId: TASK, workspaceId: 'ws', object: obj(), text: 'line a\nline b', truncated: false, cursor: null,
  fromLine: 1, toLine: 2, lineCount: 2, scannedLines: 2, scanLimited: false, ...over,
});

function transport(over: Partial<EvidenceTransport> = {}) {
  const t = {
    read: mock(async (): Promise<TransportResult<TaskEvidenceReadResponse>> => ({ ok: true, body: readBody() })),
    download: mock(async () => ({ ok: true as const, body: { url: 'https://signed.example/x', expiresAt: '2026-09-30T14:07:00.000Z', filename: 'x.gz' } })),
    open: mock((_url: string) => {}),
    ...over,
  };
  return t;
}

async function mount(objects: EvidenceObjectSummary[], t: EvidenceTransport, extra: { sensitive?: boolean } = {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => {
    createRoot(el).render(<TaskEvidenceFiles taskId={TASK} objects={objects} transport={t} defaultOpen {...extra} />);
  });
  return el;
}

const q = (el: Element, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (el: Element, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
async function click(node: HTMLElement | null) {
  if (!node) throw new Error('missing element');
  await act(async () => { node.click(); });
}
async function type(input: HTMLInputElement, value: string) {
  let proto = Object.getPrototypeOf(input);
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'value')) proto = Object.getPrototypeOf(proto);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
async function submit(form: HTMLElement | null) {
  if (!form) throw new Error('missing form');
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}

describe('TaskEvidenceFiles — list', () => {
  it('shows kind, size, upload and index state and created time for each object', async () => {
    const el = await mount([
      obj(),
      obj({ id: 'ev-2', kind: 'ci_job_log', bytes: 3 * 1024 * 1024, uploadState: 'failed', indexState: 'skipped' }),
    ], transport());
    const rows = qa(el, 'evidence-row');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Command output');
    expect(rows[0].textContent).toContain('20 KB');
    expect(rows[0].textContent).toContain('stored');
    expect(rows[0].textContent).toContain('searchable');
    expect(rows[0].textContent).toContain('2026-09-30 14:02 UTC');
    expect(rows[1].textContent).toContain('CI job log');
    expect(rows[1].textContent).toContain('3.0 MB');
    expect(rows[1].textContent).toContain('upload failed');
    expect(q(el, 'task-evidence-files')!.textContent).toContain('2');
  });

  it('offers View and Download only on stored objects', async () => {
    const el = await mount([obj(), obj({ id: 'ev-2', uploadState: 'pending' })], transport());
    const [stored, pending] = qa(el, 'evidence-row');
    expect(stored.querySelector('[data-testid="evidence-view"]')).not.toBeNull();
    expect(stored.querySelector('[data-testid="evidence-download"]')).not.toBeNull();
    expect(pending.querySelector('[data-testid="evidence-view"]')).toBeNull();
    expect(pending.querySelector('[data-testid="evidence-download"]')).toBeNull();
    expect(pending.textContent).toContain('uploading');
  });

  it('shows an unindexed object in a sensitive workspace as a neutral state, not a fault', async () => {
    const el = await mount([obj({ indexState: 'skipped' })], transport(), { sensitive: true });
    const index = q(el, 'evidence-index-state')!;
    expect(index.textContent).toBe('not indexed (sensitive workspace)');
    expect(index.className).not.toMatch(/status-(error|warning)/);
    expect(index.getAttribute('data-tone')).toBe('neutral');
    // Still readable: being unindexed never hides the object's actions.
    expect(q(el, 'evidence-view')).not.toBeNull();
  });

  it('marks an object from an earlier run of the task', async () => {
    const el = await mount([obj({ taskId: 'retry-0', rootTaskId: TASK })], transport());
    expect(q(el, 'evidence-row')!.textContent).toContain('earlier run');
  });
});

describe('TaskEvidenceFiles — empty state', () => {
  it('says nothing was stored, with no list and no viewer', async () => {
    const el = await mount([], transport());
    expect(q(el, 'evidence-empty')!.textContent).toContain('No evidence');
    expect(qa(el, 'evidence-row').length).toBe(0);
    expect(q(el, 'evidence-viewer')).toBeNull();
  });
});

describe('TaskEvidenceFiles — viewer', () => {
  it('opens on the tail of the object', async () => {
    const t = transport();
    const el = await mount([obj()], t);
    await click(q(el, 'evidence-view'));
    expect(t.read).toHaveBeenCalledTimes(1);
    expect(t.read.mock.calls[0]).toEqual([TASK, { evidenceId: 'ev-1', tail: 200 }] as never);
    expect(q(el, 'evidence-text')!.textContent).toBe('line a\nline b');
  });

  it('shows the server\'s grep refusal inline and keeps the viewer open', async () => {
    const message = 'grep pattern has more than one unbounded quantifier';
    const t = transport();
    const el = await mount([obj()], t);
    await click(q(el, 'evidence-view'));
    t.read.mockImplementation(async () => ({ ok: false, status: 400, error: message }));
    await type(q(el, 'evidence-grep') as HTMLInputElement, '.*a.*b');
    await submit(q(el, 'evidence-grep-form'));
    expect(t.read.mock.calls[1]).toEqual([TASK, { evidenceId: 'ev-1', grep: '.*a.*b' }] as never);
    const err = q(el, 'evidence-read-error')!;
    expect(err.textContent).toBe(message);
    expect(err.getAttribute('role')).toBe('alert');
    expect(q(el, 'evidence-viewer')).not.toBeNull();
    expect((q(el, 'evidence-grep') as HTMLInputElement).value).toBe('.*a.*b');
  });

  it('says when the read was truncated and loads more from the cursor', async () => {
    const t = transport();
    const el = await mount([obj()], t);
    await click(q(el, 'evidence-view'));
    t.read.mockImplementationOnce(async () => ({ ok: true, body: readBody({ text: '3:FAIL one', truncated: true, cursor: '40', fromLine: 3, toLine: 3 }) }));
    await type(q(el, 'evidence-grep') as HTMLInputElement, 'fail');
    await submit(q(el, 'evidence-grep-form'));
    expect(q(el, 'evidence-truncated')).not.toBeNull();

    t.read.mockImplementationOnce(async () => ({ ok: true, body: readBody({ text: '41:FAIL two', truncated: false, cursor: null, fromLine: 41, toLine: 41 }) }));
    await click(q(el, 'evidence-load-more'));
    expect(t.read.mock.calls[2]).toEqual([TASK, { evidenceId: 'ev-1', grep: 'fail', cursor: '40' }] as never);
    expect(q(el, 'evidence-text')!.textContent).toBe('3:FAIL one\n41:FAIL two');
    expect(q(el, 'evidence-load-more')).toBeNull();
  });

  it('in tail mode, shows earlier lines by widening the tail', async () => {
    const t = transport();
    t.read.mockImplementation(async () => ({ ok: true, body: readBody({ fromLine: 301, toLine: 500, lineCount: 200 }) }));
    const el = await mount([obj()], t);
    await click(q(el, 'evidence-view'));
    await click(q(el, 'evidence-load-more'));
    expect(t.read.mock.calls[1]).toEqual([TASK, { evidenceId: 'ev-1', tail: 1000 }] as never);
  });
});

describe('TaskEvidenceFiles — download', () => {
  it('mints a link on click and hands it to the browser', async () => {
    const t = transport();
    const el = await mount([obj()], t);
    expect(t.download).not.toHaveBeenCalled();
    await click(q(el, 'evidence-download'));
    expect(t.download.mock.calls[0]).toEqual([TASK, 'ev-1'] as never);
    expect(t.open.mock.calls[0]).toEqual(['https://signed.example/x'] as never);
  });

  it('shows a refusal next to the row', async () => {
    const t = transport({
      download: mock(async () => ({ ok: false as const, status: 409, error: 'this evidence object cannot be downloaded (upload state: pending)' })),
    });
    const el = await mount([obj()], t);
    await click(q(el, 'evidence-download'));
    expect(t.open).not.toHaveBeenCalled();
    expect(q(el, 'evidence-download-error')!.textContent).toContain('cannot be downloaded');
  });
});
