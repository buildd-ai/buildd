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
    expect(html).toContain('The runner took this attempt but never started it.');
  });
  it('says nothing ran once the task is settled, and still draws no failure', () => {
    const settled = renderToStaticMarkup(
      <BookkeepingAttemptRow workerId="w2" retry={{ kind: 'settled' }}><p>x</p></BookkeepingAttemptRow>,
    );
    expect(settled).toContain('nothing ran');
    expect(settled).not.toContain('not counted as a failure');
    expect(settled).not.toContain('status-error');
  });
  it('one line for a run of lost claims: counted, in plain words', () => {
    const grouped = renderToStaticMarkup(
      <BookkeepingAttemptRow workerId="w3" retry={{ kind: 'queued' }} count={4} undelivered attemptLabel="Attempt 4"><p>x</p></BookkeepingAttemptRow>,
    );
    expect(grouped).toContain('Claim didn&#x27;t reach the runner 4 times');
    expect(grouped).toContain('the runner never received it');
    // A per-row label would name only one of the four.
    expect(grouped).not.toContain('Attempt 4');
  });
});

