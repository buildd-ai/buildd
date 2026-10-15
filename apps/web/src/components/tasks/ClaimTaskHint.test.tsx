import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ClaimTaskHint, { CLAIM_ROW_BTN } from './ClaimTaskHint';

// Spec f7f67f1a R-39, AC-20: the card prints the short id; Copy is secondary.
describe('ClaimTaskHint', () => {
  const id = '2d857abf-0000-4000-8000-000000000000';
  const html = renderToStaticMarkup(<ClaimTaskHint taskId={id} />);
  const code = html.match(/<code[^>]*>([^<]*)<\/code>/)!;

  it('prints the 8-character id, marked as cut, and keeps the full command for copying', () => {
    expect(code[1]).toBe('claim_task {taskId: &quot;2d857abf…&quot;}');
    expect(code[0]).toContain(`title="claim_task {taskId: &quot;${id}&quot;}"`);
  });

  it('the copy button is a secondary button, never the orange primary fill', () => {
    const button = html.match(/<button[^>]*data-testid="claim-task-copy"[^>]*>/)![0];
    expect(button).toContain('class="btn ');
    expect(button).not.toMatch(/bg-primary|btn-primary|text-white/);
  });

  it('Run now and Task join Copy in one row, at one button size', () => {
    const row = renderToStaticMarkup(<ClaimTaskHint taskId={id} actions={<><button className={CLAIM_ROW_BTN}>Run now</button><a className={CLAIM_ROW_BTN}>Task →</a></>} />);
    const actions = row.slice(row.indexOf('data-testid="claim-task-actions"'));
    expect(actions.match(/class="btn min-h-11 md:min-h-9"/g)).toHaveLength(3);
    expect(actions).toContain('flex-wrap items-center');
  });
});
