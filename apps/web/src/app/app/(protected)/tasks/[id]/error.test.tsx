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
});
