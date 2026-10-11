/**
 * The task page's agent-error evidence in a browser (happy-dom): grouping and
 * colour by consequence, collapsed recovered/diagnostic sections, and the
 * full-evidence dialog a row opens. Runs in its own process
 * (scripts/run-unit-tests.ts).
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { afterEach, describe, expect, it } from 'bun:test';
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
import type { ErrorEvidenceItem } from './error-evidence';

const { default: TaskErrorEvidence } = await import('./TaskErrorEvidence');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LONG_CMD = `bun run scripts/run-unit-tests.ts ${'apps/web/src/very/long/path/segment/'.repeat(5)}thing.test.ts`;
const LONG_OUTPUT = Array.from({ length: 70 }, (_, i) => `(fail) case ${i} ${'y'.repeat(70)}`).join('\n');

const item = (over: Partial<ErrorEvidenceItem> = {}): ErrorEvidenceItem => ({
  id: 't1', pattern: 'bash_nonzero_exit', source: 'Bash', ts: '2026-09-30T14:02:05.000Z',
  excerpt: `$ ${LONG_CMD} [exit 1]\n${LONG_OUTPUT}`,
  command: LONG_CMD, exitCode: 1, output: LONG_OUTPUT,
  presentation: 'needs_attention', reason: 'A test run failed and never passed afterwards.', decidedBy: 'rule',
  headline: null,
  attempt: { label: 'Attempt 2', workerId: 'w2' },
  before: [{ ts: '2026-09-30T14:01:00.000Z', text: 'Edit foo.ts' }],
  after: [{ ts: '2026-09-30T14:03:00.000Z', text: 'Task failed' }],
  logUrl: null,
  ...over,
});

const noise = () => item({
  id: 'n1', command: 'grep -rn foo src 2>/dev/null', exitCode: 2, output: '', excerpt: '$ grep -rn foo src 2>/dev/null [exit 2]',
  presentation: 'noise', reason: 'A read-only command found nothing; expected while exploring.',
});
const recovered = () => item({ id: 'r1', presentation: 'recovered', reason: 'A later test run passed.' });
// The retry of a session that never began: its branch was only ever assigned.
const freshStart = () => item({
  id: 'f1', pattern: 'resume_branch_fallback', source: 'git-operations', command: null, exitCode: null,
  excerpt: 'Branch "buildd/6f9a5b05-recon" was missing on remote — starting fresh from "dev".',
  output: 'Branch "buildd/6f9a5b05-recon" was missing on remote — starting fresh from "dev".',
  presentation: 'noise', headline: 'Started fresh after the previous session never began',
  reason: 'It made no commits, so nothing was lost.',
  before: [{ ts: '2026-09-30T14:01:00.000Z', text: 'Worktree created' }], after: [{ ts: '2026-09-30T14:03:00.000Z', text: 'Read spec.md' }],
});
const lostWork = () => item({
  id: 'l1', pattern: 'resume_branch_fallback', source: 'git-operations', command: null, exitCode: null,
  excerpt: 'Branch "buildd/x" was missing on remote — starting fresh from "dev".', output: 'Branch "buildd/x" was missing on remote — starting fresh from "dev".',
  headline: "A previous attempt's commits were not on the remote",
  reason: 'This attempt started over without them; check whether that work needs redoing.',
});
const unclear = () => item({ id: 'u1', command: 'make deploy', presentation: 'unclear', reason: 'The record does not say.' });

let roots: Array<{ unmount(): void }> = [];
afterEach(() => {
  act(() => { for (const r of roots) r.unmount(); });
  roots = [];
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

async function mount(items: ErrorEvidenceItem[], terminalSucceeded = false, taskState: string | null = null) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  await act(async () => {
    root.render(<TaskErrorEvidence items={items} taskTitle="Fix the login flow" terminalSucceeded={terminalSucceeded} taskState={taskState} />);
  });
  return el;
}

const q = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const qa = (el: ParentNode, id: string) => [...el.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const RED = /status-error|red-\d/;
const hasRed = (el: Element) => [el, ...el.querySelectorAll('*')].some(n => RED.test(n.getAttribute('class') ?? ''));

async function click(node: HTMLElement | null) {
  if (!node) throw new Error('missing element');
  await act(async () => { node.click(); });
}

const toggleFor = (section: HTMLElement) => section.querySelector('button[aria-expanded]') as HTMLButtonElement;

describe('TaskErrorEvidence', () => {
  it('renders nothing with no items', async () => {
    const el = await mount([]);
    expect(el.innerHTML).toBe('');
  });

  it('keeps the anchor other code links to', async () => {
    const el = await mount([item()]);
    const root = q(el, 'task-error-evidence')!;
    expect(root.id).toBe('agent-error-traces');
  });

  it('shows a needs-attention row as what failed, what it affects and the action', async () => {
    const el = await mount([item()]);
    const row = q(el, 'error-evidence-row')!;
    expect(row.getAttribute('data-presentation')).toBe('needs_attention');
    expect(row.textContent).toContain(LONG_CMD);
    expect(row.textContent).toContain('Tests did not pass, so the change is not verified.');
    expect(row.textContent).toContain('Open full evidence');
    expect(hasRed(q(el, 'error-evidence-attention')!)).toBe(true);
    expect(Number(row.className.includes('min-h-11'))).toBe(1);
  });

  it('shows a CI/log link only when the item carries one', async () => {
    let el = await mount([item()]);
    expect(q(el, 'error-evidence-log-link')).toBeNull();
    el = await mount([item({ id: 'x', logUrl: 'https://github.com/o/r/actions/runs/1' })]);
    expect(q(el, 'error-evidence-log-link')!.getAttribute('href')).toBe('https://github.com/o/r/actions/runs/1');
  });

  it('collapses diagnostic noise by default and never colours it red', async () => {
    const el = await mount([noise()]);
    const section = q(el, 'error-evidence-noise')!;
    expect(section.textContent).toContain('Diagnostic');
    expect(toggleFor(section).getAttribute('aria-expanded')).toBe('false');
    expect(qa(section, 'error-evidence-row')).toHaveLength(0);
    await click(toggleFor(section));
    expect(qa(section, 'error-evidence-row')).toHaveLength(1);
    expect(hasRed(q(el, 'task-error-evidence')!)).toBe(false);
    expect(q(el, 'error-evidence-attention-count')).toBeNull();
  });

  it('collapses recovered issues by default with a count, muted', async () => {
    const el = await mount([recovered(), item({ id: 'r2', presentation: 'recovered' })]);
    const section = q(el, 'error-evidence-recovered')!;
    expect(section.textContent).toContain('Recovered issues');
    expect(section.textContent).toContain('2');
    expect(toggleFor(section).getAttribute('aria-expanded')).toBe('false');
    await click(toggleFor(section));
    expect(qa(section, 'error-evidence-row')).toHaveLength(2);
    expect(hasRed(q(el, 'task-error-evidence')!)).toBe(false);
  });

  it('shows unclear rows, neutral', async () => {
    const el = await mount([unclear()]);
    const section = q(el, 'error-evidence-unclear')!;
    expect(qa(section, 'error-evidence-row')).toHaveLength(1);
    expect(hasRed(q(el, 'task-error-evidence')!)).toBe(false);
  });

  it('counts only needs-attention items in the red badge', async () => {
    const el = await mount([item(), item({ id: 'a2' }), noise(), recovered(), unclear()]);
    expect(q(el, 'error-evidence-attention-count')!.textContent).toContain('2');
  });

  it('renders nothing red once the task succeeded; model-judged attention items move under recovered', async () => {
    const el = await mount([item({ decidedBy: 'model' }), noise()], true);
    expect(q(el, 'error-evidence-attention')).toBeNull();
    expect(q(el, 'error-evidence-attention-count')).toBeNull();
    const section = q(el, 'error-evidence-recovered')!;
    await click(toggleFor(section));
    expect(qa(section, 'error-evidence-row')).toHaveLength(1);
    expect(hasRed(q(el, 'task-error-evidence')!)).toBe(false);
  });

  it('opens the complete evidence in a dialog from a row, and Escape closes it', async () => {
    const el = await mount([item()]);
    await click(q(el, 'error-evidence-row'));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Fix the login flow');
    expect(dialog.textContent).toContain('Attempt 2');
    expect(q(dialog, 'error-evidence-consequence')!.textContent).toBe('Tests did not pass, so the change is not verified.');
    expect(q(dialog, 'error-evidence-command')!.textContent).toBe(LONG_CMD);
    expect(q(dialog, 'error-evidence-output')!.textContent).toBe(LONG_OUTPUT);
    expect(dialog.textContent).toContain('Edit foo.ts');
    expect(dialog.textContent).toContain('Task failed');
    expect(dialog.textContent).toContain('bash_nonzero_exit');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.className).toContain('h-[100dvh]');
    expect(dialog.className).toContain('md:max-h-[90dvh]');
    expect(document.body.style.overflow).toBe('hidden');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });

  it('opens a noise row too, with the full excerpt', async () => {
    const el = await mount([noise()]);
    await click(toggleFor(q(el, 'error-evidence-noise')!));
    await click(q(el, 'error-evidence-row'));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    // Not current, so the evidence waits behind its disclosure.
    expect(q(dialog, 'error-evidence-command')).toBeNull();
    await click(toggleFor(dialog));
    expect(q(dialog, 'error-evidence-command')!.textContent).toBe('grep -rn foo src 2>/dev/null');
    expect(hasRed(dialog)).toBe(false);
  });

  it('closes from the close button', async () => {
    const el = await mount([item()]);
    await click(q(el, 'error-evidence-row'));
    await click(document.querySelector('[role="dialog"] button[aria-label="Close"]') as HTMLElement);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows a fresh start after a never-started session as one compact diagnostic line, no PR claim', async () => {
    const el = await mount([freshStart()], true, 'Done');
    expect(q(el, 'error-evidence-recovered')).toBeNull();
    expect(q(el, 'error-evidence-attention-count')).toBeNull();
    const section = q(el, 'error-evidence-noise')!;
    await click(toggleFor(section));
    const row = q(section, 'error-evidence-row')!;
    expect(row.textContent).toContain('Started fresh after the previous session never began');
    expect(row.textContent).not.toContain('missing on remote');
    expect(row.textContent).not.toMatch(/\bPR\b|landed|got past/);
    expect(hasRed(q(el, 'task-error-evidence')!)).toBe(false);
  });

  it('its sheet leads with the task state and one consequence; excerpt and milestones behind a disclosure', async () => {
    const el = await mount([freshStart()], true, 'Done');
    await click(toggleFor(q(el, 'error-evidence-noise')!));
    await click(q(el, 'error-evidence-row'));
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(q(dialog, 'error-evidence-task-state')!.textContent).toBe('Task: Done');
    expect(q(dialog, 'error-evidence-consequence')!.textContent).toBe('It made no commits, so nothing was lost.');
    expect(dialog.textContent).not.toMatch(/landed|got past|did not stop it|\bPR\b/);
    expect(q(dialog, 'error-evidence-output')).toBeNull();
    expect(dialog.textContent).not.toContain('Worktree created');
    await click(toggleFor(dialog));
    expect(q(dialog, 'error-evidence-output')!.textContent).toContain('missing on remote');
    expect(dialog.textContent).toContain('Worktree created');
    expect(hasRed(dialog)).toBe(false);
  });

  it('keeps lost work from an earlier attempt red and counted, even once the task succeeded', async () => {
    const el = await mount([lostWork()], true, 'Done');
    expect(q(el, 'error-evidence-attention-count')!.textContent).toContain('1');
    const row = q(q(el, 'error-evidence-attention')!, 'error-evidence-row')!;
    expect(row.textContent).toContain("A previous attempt's commits were not on the remote");
    expect(row.textContent).toContain('check whether that work needs redoing');
    await click(row);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    // Current, so the evidence is open.
    expect(q(dialog, 'error-evidence-output')).not.toBeNull();
  });
});
