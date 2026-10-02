/**
 * The question surface with a decision brief, in a browser (happy-dom): the
 * context line, where it was asked from, each option's consequence and the
 * recommended default. A question without a brief still renders.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1/respond' });

import { describe, expect, it } from 'bun:test';
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: QuestionHero } = await import('./QuestionHero');
const { unifyWorkerQuestion } = await import('./question-hero');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(waitingFor: Parameters<typeof unifyWorkerQuestion>[0]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const answers: string[] = [];
  await act(async () => {
    root.render(
      <QuestionHero
        question={unifyWorkerQuestion(waitingFor, null)}
        askerLabel="The builder asks"
        onAnswer={(a) => { answers.push(a); }}
        sending={null}
      />,
    );
  });
  return { host, answers, unmount: () => act(async () => root.unmount()) };
}

describe('QuestionHero with a question brief', () => {
  it('shows the decision, where it came from, what each option leads to, and the default', async () => {
    const { host, answers, unmount } = await render({
      type: 'question',
      prompt: 'Should it use local time or UTC?',
      context: 'isWeekend() decides weekend surcharges in the billing helpers.',
      options: [
        { label: 'Local time', consequence: 'Customers are charged by their own calendar.' },
        { label: 'UTC', consequence: 'Late Friday customers in the Americas get weekend rates.' },
      ],
      recommended: { label: 'Local time', reason: 'Customers are charged by their own calendar.' },
      where: { taskTitle: 'Weekend surcharge', branch: 'buildd/abc-weekend', file: 'src/billing/dates.ts' },
    });
    expect(host.querySelector('[data-testid="worker-needs-input-prompt"]')!.textContent).toBe('Should it use local time or UTC?');
    expect(host.querySelector('[data-testid="question-brief-context"]')!.textContent).toBe('isWeekend() decides weekend surcharges in the billing helpers.');
    expect(host.querySelector('[data-testid="question-brief-where"]')!.textContent).toBe('Weekend surcharge · buildd/abc-weekend · src/billing/dates.ts');
    const opts = [...host.querySelectorAll('[data-testid="question-option"]')];
    expect(opts).toHaveLength(2);
    expect(opts[0].getAttribute('data-recommended')).toBe('true');
    expect(opts[0].textContent).toContain('Recommended');
    expect(opts[0].textContent).toContain('Customers are charged by their own calendar.');
    expect(opts[1].textContent).toContain('Late Friday customers in the Americas get weekend rates.');
    await act(async () => { (opts[0] as HTMLButtonElement).click(); });
    expect(answers).toEqual(['Local time']);
    await unmount();
  });

  it('an old question without a brief still renders, with no brief lines', async () => {
    const { host, unmount } = await render({ type: 'question', prompt: 'Should isWeekend use local time or UTC?', options: ['local time', 'UTC'] });
    expect(host.querySelector('[data-testid="worker-needs-input-prompt"]')!.textContent).toBe('Should isWeekend use local time or UTC?');
    expect(host.querySelector('[data-testid="question-brief-context"]')).toBeNull();
    expect(host.querySelector('[data-testid="question-brief-where"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="question-option"]')).toHaveLength(2);
    await unmount();
  });
});
