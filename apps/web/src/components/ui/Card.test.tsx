import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import Card from './Card';

const css = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`\\n {2}${selector.replace(/[.:]/g, m => `\\${m}`)} \\{([^}]*)\\}`))?.[1] ?? '';

describe('Card', () => {
  it('is the L2 card: the .card class on a div, md padding by default', () => {
    const html = renderToStaticMarkup(<Card>Body</Card>);
    expect(html).toMatch(/^<div class="card p-4"[^>]*data-card="2">Body<\/div>$/);
  });

  it('padding scale: sm and md', () => {
    expect(renderToStaticMarkup(<Card padding="sm">x</Card>)).toContain('class="card p-3"');
    expect(renderToStaticMarkup(<Card padding="md">x</Card>)).toContain('class="card p-4"');
  });

  it('renders as another element and passes extra props through', () => {
    const html = renderToStaticMarkup(<Card as="section" aria-labelledby="h" data-testid="c" className="mt-2">x</Card>);
    expect(html).toMatch(/^<section class="card p-4 mt-2" aria-labelledby="h" data-testid="c"/);
  });

  it('interactive adds the hover and focus state for linked cards', () => {
    expect(renderToStaticMarkup(<Card interactive>x</Card>)).toContain('class="card card-interactive p-4"');
  });

  it('bare draws no frame, only the padding, for a card nested in a card', () => {
    const html = renderToStaticMarkup(<Card bare padding="sm">x</Card>);
    expect(html).toContain('class="p-3"');
    expect(html).not.toContain('card');
  });

  it('uses no raw colour, radius or shadow of its own', () => {
    const src = readFileSync(join(import.meta.dir, 'Card.tsx'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b|rounded|shadow|border-/i);
  });
});

describe('.card and Card share one look', () => {
  it('.card is a 1px --border hairline on --card at the card radius, with no shadow', () => {
    const card = rule('.card');
    expect(card).toContain('background: var(--card);');
    expect(card).toContain('border: 1px solid var(--border);');
    expect(card).toContain('border-radius: var(--radius-card);');
    expect(card).not.toMatch(/shadow/);
  });

  it('.card-interactive has a hover and a visible keyboard focus', () => {
    expect(rule('.card-interactive:hover')).toContain('background: var(--card-hover);');
    expect(rule('.card-interactive:focus-visible')).toMatch(/outline: 2px solid var\(--text-primary\);/);
  });
});
