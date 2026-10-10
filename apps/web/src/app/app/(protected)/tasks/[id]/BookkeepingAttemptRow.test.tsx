import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import BookkeepingAttemptRow from './BookkeepingAttemptRow';

describe('BookkeepingAttemptRow', () => {
  const html = renderToStaticMarkup(
    <BookkeepingAttemptRow workerId="w1" retry={{ kind: 'queued' }} attemptLabel="Attempt 1">
      <p>Branch: buildd/abc</p>
    </BookkeepingAttemptRow>,
  );
  it('is a native disclosure with a neutral one-line summary', () => {
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('Session didn&#x27;t start');
    expect(html).toContain('retry queued');
  });
  it('shows no failure styling', () => {
    expect(html).not.toContain('status-error');
    expect(html).not.toContain('✕');
  });
  it('keeps the diagnostics inside the disclosure', () => {
    expect(html).toContain('Branch: buildd/abc');
    expect(html).toContain('not a task failure');
  });
});
