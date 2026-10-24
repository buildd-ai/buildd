/**
 * The question surface with a decision brief, in a browser (happy-dom): the
 * context line, where it was asked from, each option's consequence and the
 * recommended default. A question without a brief still renders.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1?respond=1' });

import { describe, expect, it } from 'bun:test';
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: QuestionHero } = await import('./QuestionHero');
const { unifyWorkerQuestion } = await import('./question-hero');
const { optionOutcomes } = await import('@buildd/core/question-waits');
type QuestionWaits = import('@buildd/core/question-waits').QuestionWaits;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(waitingFor: Parameters<typeof unifyWorkerQuestion>[0], waits: QuestionWaits | null = null) {
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
        waits={waits}
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

  // Living Spec 1b257609 r2 (task page): the projection fills the summary, the option lines and the footer.
  it('names what waits on the answer, each option\'s effect and the expiry, recommended option first', async () => {
    const base: QuestionWaits = {
      taskId: 't1', mission: null, hiddenCount: 0, beyondCount: 0, lanes: [], criteria: { specId: 's1', specTitle: 'Billing totals', affected: ['R-1', 'R-2'], total: 4 },
      waiting: [{ id: 'b1', title: 'Invoice rounding', depth: 1, missionId: null, missionTitle: null, workspaceName: null, after: null, alsoWaitsOnOther: false }],
      askedAt: null, expiresAt: new Date(Date.now() + 90 * 60_000 + 20_000).toISOString(), onExpiry: { action: 'default', option: 'Local time' }, options: [],
    };
    const waits = { ...base, options: optionOutcomes([{ label: 'UTC', outcome: 'changes' }, { label: 'Local time', outcome: 'finishes', recommended: true }], base) };
    const { host, unmount } = await render({
      type: 'question', prompt: 'Should it use local time or UTC?',
      options: [{ label: 'UTC', consequence: 'Simpler.' }, { label: 'Local time', consequence: 'Own calendar.', recommended: true }],
    }, waits);
    const summary = host.querySelector('[data-testid="question-waits"]')!;
    expect(summary.textContent).toBe('Waits on this: Invoice rounding. Affects the evidence for 2 of 4 criteria in Billing totals.');
    expect([...summary.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['/app/tasks/b1', '/app/specs/s1']);
    const opts = [...host.querySelectorAll('[data-testid="question-option"]')];
    expect(opts[0].textContent).toContain('Local time');
    expect([...host.querySelectorAll('[data-testid="question-option-downstream"]')].map(e => e.textContent)).toEqual([
      'Finishes the task: Invoice rounding starts',
      'Changes what it delivers: Invoice rounding starts on the changed result',
    ]);
    expect(host.querySelector('[data-testid="question-expiry"]')!.textContent).toBe('Expires in 1 hour 30 minutes, then the task starts again and the agent goes with Local time.');
    await unmount();
  });

  it('without the projection, only the agent\'s lines', async () => {
    const { host, unmount } = await render({ type: 'question', prompt: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] });
    expect(host.querySelector('[data-testid="question-waits"]')).toBeNull();
    expect(host.querySelector('[data-testid="question-expiry"]')).toBeNull();
    await unmount();
  });
});
