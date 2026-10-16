/**
 * The question on a phone: option cards stay compact (clamped consequence with
 * a toggle), the context clamps with "more", and the block lands at the top of
 * the viewport once on arrival, never again.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { describe, expect, it } from 'bun:test';
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: QuestionHero } = await import('./QuestionHero');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const long = 'A long consequence that explains in detail what choosing this leads to downstream. '.repeat(3);
const question = {
  headline: 'How should the three backend tasks get filed?',
  context: long,
  body: null,
  noteId: null,
  options: [
    { label: 'One task each', description: long, recommended: true },
    { label: 'One umbrella task', description: long },
    { label: 'Mission', description: 'Short.' },
  ],
} as never;

async function mount(landOnArrival: boolean, scrolls: unknown[]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const proto = (globalThis as unknown as { HTMLElement: { prototype: { scrollIntoView: unknown } } }).HTMLElement.prototype;
  proto.scrollIntoView = function (arg: unknown) { scrolls.push(arg); };
  const el = (n: number) => (
    <QuestionHero key={n} question={question} askerLabel="The builder asks" onAnswer={() => {}} sending={null} landOnArrival={landOnArrival} />
  );
  await act(async () => { root.render(el(0)); });
  return { host, rerender: () => act(async () => { root.render(el(0)); }) };
}

describe('QuestionHero on a phone', () => {
  it('clamps long consequences and context, and the toggle expands them', async () => {
    const { host } = await mount(false, []);
    const desc = host.querySelectorAll('[data-testid="question-option"] [data-clamped]');
    expect(desc[0].className).toContain('line-clamp-3'); // recommended
    expect(desc[1].className).toContain('line-clamp-2');
    expect(desc[0].className).toContain('@md:line-clamp-none'); // desktop unchanged
    const ctx = host.querySelector('[data-testid="question-brief-context"]')!;
    expect(ctx.className).toContain('line-clamp-2');
    // Only overflowing text gets a toggle: two options + the context.
    const toggles = host.querySelectorAll('[data-testid="clamp-toggle"]');
    expect(toggles).toHaveLength(3);
    expect(toggles[1].closest('[data-testid="question-option"]')).toBeNull(); // not nested in the answer button
    await act(async () => { (toggles[1] as HTMLButtonElement).click(); });
    expect(host.querySelector('[data-testid="question-option"] [data-clamped]')!.getAttribute('data-clamped')).toBe('false');
  });

  it('scrolls the question to the top once on arrival, not on later renders', async () => {
    const scrolls: unknown[] = [];
    const { rerender } = await mount(true, scrolls);
    expect(scrolls).toEqual([{ block: 'start' }]);
    await rerender();
    expect(scrolls).toHaveLength(1);
  });

  it('does not scroll unless asked to', async () => {
    const scrolls: unknown[] = [];
    await mount(false, scrolls);
    expect(scrolls).toHaveLength(0);
  });
});
