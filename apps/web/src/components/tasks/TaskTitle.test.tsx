import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttemptChip, TaskTitle } from './TaskTitle';

const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('TaskTitle (§2.10): the retry key never renders', () => {
  it('a retry title reads the title plus an attempt chip', () => {
    const html = renderToStaticMarkup(<TaskTitle title="[builder · after review #2] fix(timeline): duplicate day header" />);
    expect(text(html)).toBe('fix(timeline): duplicate day headerFix 2 · review asked for changes');
    expect(html).toContain('data-testid="task-attempt"');
  });

  it('the short form drops the conventional prefix as displayTaskTitle does', () => {
    const html = renderToStaticMarkup(<TaskTitle short title="[builder · after conflict #1] fix(timeline): duplicate day header" />);
    expect(text(html)).toBe('Duplicate day headerFix 1 · merge conflict');
  });

  it('a plain title has no chip', () => {
    const html = renderToStaticMarkup(<TaskTitle title="feat: plain" />);
    expect(html).toBe('feat: plain');
    expect(renderToStaticMarkup(<AttemptChip title="feat: plain" />)).toBe('');
  });
});
