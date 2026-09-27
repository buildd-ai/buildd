/**
 * The task page's question: number keys answer either way, but the keycaps
 * and "Press 1 or 2 to answer" show only with keyboard hints turned on.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { KeyHintsProvider } from '@/components/KeyHints';
import QuestionHero from './QuestionHero';

const question = {
  headline: 'Round per line, or only the total?',
  body: null,
  noteId: null,
  options: [
    { label: 'Per line', description: 'Match Stripe', recommended: true },
    { label: 'Total only', description: 'Match the ledger' },
  ],
} as never;

const hero = (hints: boolean) => renderToStaticMarkup(
  <KeyHintsProvider value={hints}>
    <QuestionHero question={question} askerLabel="The builder asks" onAnswer={() => {}} sending={null} enableKeys />
  </KeyHintsProvider>,
);

describe('QuestionHero keyboard hints', () => {
  it('hides the keycaps and the "Press" line by default', () => {
    const out = hero(false);
    expect(out).not.toContain('<kbd');
    expect(out).not.toContain('Press');
    expect(out).toContain('Per line');
    expect(out).toContain('Total only');
  });

  it('shows them for someone who turned hints on', () => {
    const out = hero(true);
    expect(out).toContain('<kbd');
    expect(out).toContain('Press');
    expect(out).toContain('to answer');
  });
});
