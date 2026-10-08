import { expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkerStats from './WorkerStats';

// docs/specs/real-and-virtual-cost.md: the worker's own basis decides how its
// dollars read, never the account's authType.
it('labels a virtual run\'s dollars as list-price value and still shows its tokens', () => {
  const html = renderToStaticMarkup(<WorkerStats costUsd="1.5" inputTokens={1000} outputTokens={200} costBasis="virtual" />);
  expect(html).toContain('List-price value:');
  expect(html).toContain('$1.500');
  expect(html).toContain('1,200');
});

it('labels a real run\'s dollars as cost', () => {
  const html = renderToStaticMarkup(<WorkerStats costUsd="0.25" inputTokens={10} outputTokens={1} costBasis="real" />);
  expect(html).toContain('Cost:');
  expect(html).not.toContain('List-price');
});

it('shows no dollar figure for a run that recorded no cost', () => {
  const html = renderToStaticMarkup(<WorkerStats costUsd="0" inputTokens={10} outputTokens={1} costBasis={null} />);
  expect(html).not.toContain('$');
  expect(html).toContain('Tokens:');
});
