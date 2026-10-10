/**
 * 0.22.0: `ChatThread compose="turn"`. An assistant turn has fixed regions
 * (head, work line, the work's tool rows, then its phases, each an answer slot,
 * its blocks, the card that closed it, its results) so a streamed word, a tool
 * finishing or a card arriving never moves what is already on screen.
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/chat' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const h = createElement as (type: unknown, props?: unknown, ...children: unknown[]) => any;
const { createRoot } = await import('react-dom/client');
const kit = await import('./index');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const render = async (el: unknown) => { await act(async () => { root.render(el as never); }); };
const $ = (sel: string) => container.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...container.querySelectorAll<HTMLElement>(sel)];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const EARLY = 'A fix is already queued. Let me check why it has not been claimed.';
const FINAL = 'I checked the queue: the fix was never queued. The task is held on a question nobody answered.';
const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Why is the fix not claimed?' }] };
const turn = (parts: unknown[]) => [user, { id: 'a1', role: 'assistant', parts }];
const obj = (id: string) => ({ kind: 'task', id, fallbackText: `Task ${id}` });
const read = (id: string, over: Record<string, unknown> = {}) => ({ type: 'tool-search', toolCallId: id, state: 'output-available', input: {}, output: { summary: `${id} done`, objects: [obj(`${id}-obj`)] }, ...over });
const write = (id: string, over: Record<string, unknown> = {}) => ({ type: 'tool-file', toolCallId: id, state: 'output-available', input: {}, output: { summary: 'filed', objects: [obj(`${id}-obj`)] }, ...over });
const asked = (id: string) => ({ type: 'tool-file', toolCallId: id, state: 'approval-requested', input: { title: 'fix' }, approval: { id: `ap-${id}` } });

/** The order of the turn's regions, by their kit class or test id. */
function regions(): string[] {
  const msg = $('.kit-msg[data-role="assistant"]');
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const c of el.children) {
      const cls = String(c.className);
      if (cls.includes('kit-phase-results')) out.push('results');
      else if (cls.includes('kit-answer')) out.push(`answer:${c.textContent}`);
      else if (cls.includes('kit-turn-work')) out.push('work');
      else if (cls.includes('kit-thinking')) out.push('line');
      else if (cls.includes('kit-phase')) walk(c);
      else {
        const card = c.matches('[data-testid="card"]') ? c : c.querySelector(':scope > [data-testid="card"]');
        if (card) out.push(`card:${card.getAttribute('data-id')}`);
      }
    }
  };
  if (msg) walk(msg);
  return out;
}

const props = (messages: unknown, status: string, extra: Record<string, unknown> = {}) => ({
  messages, status, compose: 'turn',
  renderToolGroup: (ps: Array<{ toolCallId: string }>) => h('div', { 'data-testid': 'rows' }, ps.map(p => p.toolCallId).join(',')),
  renderTool: (p: { toolCallId: string; approval?: unknown; state: string }) => (p.approval || p.state === 'approval-requested'
    ? h('div', { 'data-testid': 'card', 'data-id': p.toolCallId, 'data-approval-id': `ap-${p.toolCallId}` }, `card ${p.toolCallId}`)
    : undefined),
  renderPhaseResults: (m: { parts: Array<{ toolCallId?: string; output?: { objects?: Array<{ id: string }> } }> }, phase: { from: number; to: number }) => {
    const ids = m.parts.slice(phase.from, phase.to).flatMap(p => p.output?.objects?.map(o => o.id) ?? []);
    return ids.length ? h('div', { 'data-testid': 'objs' }, ids.join(',')) : null;
  },
  ...extra,
});

describe('ChatThread compose="turn" (0.22.0)', () => {
  it('the slow sequence keeps one answer node in one place: interim, tools, card results, final', async () => {
    const frames: Array<[unknown[], string]> = [
      [[{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'streaming' }], 'streaming'],
      [[{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'done' }, write('w1', { state: 'input-available', output: undefined })], 'streaming'],
      [[{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'done' }, write('w1')], 'streaming'],
      [[{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'done' }, write('w1'), { type: 'step-start' }, { type: 'text', text: FINAL, state: 'streaming' }], 'streaming'],
      [[{ type: 'step-start' }, { type: 'text', text: EARLY, state: 'done' }, write('w1'), { type: 'step-start' }, { type: 'text', text: FINAL, state: 'done' }], 'ready'],
    ];
    let node: HTMLElement | null = null;
    const seen: string[][] = [];
    for (const [parts, status] of frames) {
      await render(h(kit.ChatThread, props(turn(parts), status)));
      const answers = $$('[data-testid="kit-answer"]');
      expect(answers).toHaveLength(1);
      node ??= answers[0];
      expect(answers[0]).toBe(node);
      seen.push(regions());
    }
    // Results wait for the phase to settle: never a card above prose that then moves.
    expect(seen.slice(0, 4).every(r => !r.includes('results'))).toBe(true);
    expect(seen[4]).toEqual(['work', `answer:${FINAL}`, 'results']);
    expect($('[data-testid="objs"]')?.textContent).toBe('w1-obj');
    // Only the final prose in the settled answer.
    expect(container.textContent).not.toContain(EARLY);
  });

  it('the answer sits above the tool rows\' results whatever order the parts arrived in', async () => {
    await render(h(kit.ChatThread, props(turn([read('r1'), { type: 'text', text: FINAL }]), 'ready')));
    expect(regions()).toEqual(['work', `answer:${FINAL}`, 'results']);
  });

  it('approval: rationale and card stay put; the reply mounts as a new node below the card', async () => {
    const rationale = 'I can file the fix. Approve it below.';
    await render(h(kit.ChatThread, props(turn([{ type: 'text', text: rationale }, asked('w1')]), 'ready')));
    const card = $('[data-testid="card"]')!;
    const before = $('[data-testid="kit-answer"]')!;
    expect(regions()).toEqual([`answer:${rationale}`, 'card:w1']);

    const resumed = (state: 'streaming' | 'done') => turn([
      { type: 'text', text: rationale },
      write('w1', { approval: { id: 'ap-w1', approved: true } }),
      { type: 'step-start' },
      { type: 'text', text: 'Filed the fix; a builder can claim it now.', state },
    ]);
    await render(h(kit.ChatThread, props(resumed('streaming'), 'streaming')));
    expect($('[data-testid="card"]')).toBe(card);
    const answers = $$('[data-testid="kit-answer"]');
    expect(answers).toHaveLength(2);
    // The rationale is the same node, still above its card; the reply is new and below it.
    expect(answers[0]).toBe(before);
    expect(answers[0].textContent).toBe(rationale);
    expect(answers[0].getAttribute('data-answer')).toBe('settled');
    expect(answers[1]).not.toBe(before);
    expect(card.compareDocumentPosition(answers[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(answers[1].getAttribute('aria-busy')).toBe('true');
    expect(answers[0].hasAttribute('aria-busy')).toBe(false);

    await render(h(kit.ChatThread, props(resumed('done'), 'ready')));
    expect($$('[data-testid="kit-answer"]')[1]).toBe(answers[1]);
    expect(regions()).toEqual([`answer:${rationale}`, 'card:w1', 'results', 'answer:Filed the fix; a builder can claim it now.']);
    // The phase the card closed carries it as its terminal block.
    expect($('.kit-phase[data-closed="approval"]')?.contains(card)).toBe(true);
  });

  it('the results of a phase closed by a card mount with the card, not later above it', async () => {
    const parts = [read('r1'), { type: 'text', text: 'Here is a draft.' }, asked('w1')];
    await render(h(kit.ChatThread, props(turn(parts), 'streaming')));
    expect(regions()).toEqual(['line', 'work', 'answer:Here is a draft.', 'card:w1', 'results']);
  });

  it('a folded turn hides its tool rows, never its answer, cards or results', async () => {
    const parts = [read('r1'), { type: 'text', text: FINAL }];
    await render(h(kit.ChatThread, props(turn(parts), 'ready', {
      turnFold: { summary: () => 'Did 1 step', isOpen: () => false, onToggle: () => {} },
    })));
    expect(regions()).toEqual(['line', `answer:${FINAL}`, 'results']);
    expect($('[data-testid="rows"]')).toBeNull();
  });

  it('the work line keeps its place: tool rows go under it, never between answer and cards', async () => {
    const parts = [{ type: 'text', text: EARLY }, read('r1'), { type: 'text', text: FINAL }, read('r2')];
    await render(h(kit.ChatThread, props(turn(parts), 'ready')));
    expect(regions()).toEqual(['work', `answer:${FINAL}`, 'results']);
    expect($('[data-testid="rows"]')?.textContent).toBe('r1,r2');
  });

  it('turn regions are keyed: results and answer survive a status flip and a re-render', async () => {
    const parts = [read('r1'), { type: 'text', text: FINAL }];
    await render(h(kit.ChatThread, props(turn(parts), 'ready')));
    const results = $('.kit-phase-results');
    const answer = $('[data-testid="kit-answer"]');
    await render(h(kit.ChatThread, props(turn([...parts]), 'ready')));
    expect($('.kit-phase-results')).toBe(results);
    expect($('[data-testid="kit-answer"]')).toBe(answer);
  });

  it('without renderPhaseResults, rich rows draw the phase\'s objects after the answer', async () => {
    await render(h(kit.ChatThread, {
      messages: turn([read('r1'), { type: 'text', text: FINAL }]), status: 'ready', compose: 'turn', toolRows: 'rich',
      renderObject: (o: { id: string }) => h('span', { 'data-testid': 'o' }, o.id),
    }));
    const answer = $('[data-testid="kit-answer"]')!;
    const o = $('[data-testid="o"]')!;
    expect(o.textContent).toBe('r1-obj');
    expect(answer.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the default compose is unchanged: no phases', async () => {
    await render(h(kit.ChatThread, { messages: turn([read('r1'), { type: 'text', text: FINAL }]), status: 'ready', answer: 'replace' }));
    expect($('.kit-phase')).toBeNull();
    expect($('.kit-msg[data-compose]')).toBeNull();
  });
});
