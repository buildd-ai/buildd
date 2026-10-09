import { afterEach, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ErrorState from './ErrorState';

const SQL = 'Failed query: select "id" from "tasks" where "tasks"."id" = $1 params: 088decdb-7496-4d55-abf2-2324556fcba5';
const env = process.env as Record<string, string | undefined>;
const original = env.NODE_ENV;
afterEach(() => { env.NODE_ENV = original; });

describe('ErrorState', () => {
  it('leads with the sentence and a Retry button, raw text only inside Details', () => {
    env.NODE_ENV = 'development';
    const html = renderToStaticMarkup(<ErrorState message="We couldn't load this task. Try again." detail={SQL} onRetry={() => {}} />);
    expect(html).toContain("We couldn&#x27;t load this task");
    expect(html).toContain('Retry');
    const outside = html.replace(/<details[\s\S]*<\/details>/, '');
    expect(outside).not.toContain('Failed query');
    expect(html).toContain('<summary');
    expect(html).toContain('Failed query');
  });

  it('never renders raw text or ids in production, only the digest', () => {
    env.NODE_ENV = 'production';
    const html = renderToStaticMarkup(<ErrorState message="Sorry." detail={SQL} digest="d1g3st" onRetry={() => {}} />);
    expect(html).not.toContain('Failed query');
    expect(html).not.toContain('088decdb');
    expect(html).toContain('d1g3st');
  });
});
