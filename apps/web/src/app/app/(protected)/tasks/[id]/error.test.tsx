import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskError from './error';

describe('TaskError', () => {
  it('does not print the database error as body text', () => {
    const error = new Error('Failed query: select "id" from "tasks" where "id" = $1 params: abc');
    const html = renderToStaticMarkup(<TaskError error={error} reset={() => {}} />);
    const outside = html.replace(/<details[\s\S]*<\/details>/, '');
    expect(outside).not.toContain('Failed query');
    expect(outside).toContain('Retry');
  });

  it('says what happened in a sentence-case heading, not an all-caps label', () => {
    const html = renderToStaticMarkup(<TaskError error={new Error('x')} reset={() => {}} />);
    expect(html).toContain('This task couldn’t load');
    expect(html).not.toMatch(/upper[c]ase/);
  });
});
