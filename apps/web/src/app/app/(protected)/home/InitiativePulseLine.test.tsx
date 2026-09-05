import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InitiativePulseLine, PULSE_LINE_TESTID } from './InitiativePulseLine';
import type { PulseLineItem } from '@/lib/initiative-pulse-line';
import type { Verdict } from '@/lib/verdict-presentation';

function arc(id: string, title: string, verdict: Verdict): PulseLineItem {
  return { id, title, verdict };
}

/**
 * The one-line initiative pulse (spec §2). Rendered rather than source-checked
 * because the assertion that matters is the DOM: AC-1 says "no pulse line
 * element is present", which only a render can show.
 */
describe('InitiativePulseLine', () => {
  it('renders absence — not empty chrome — when no arc contributes a clause (AC-1)', () => {
    const html = renderToStaticMarkup(
      <InitiativePulseLine items={[arc('i-1', 'Alpha', 'winning'), arc('i-2', 'Beta', 'dormant')]} />,
    );
    // No wrapper, no label, no "nothing to see" text (§2.2).
    expect(html).toBe('');
  });

  it('renders the clause line and links to the list (AC-2)', () => {
    const html = renderToStaticMarkup(
      <InitiativePulseLine items={[arc('i-1', 'Alpha', 'grinding'), arc('i-2', 'Beta', 'stuck')]} />,
    );
    // The full clause string can only appear if the line itself rendered — a
    // bare toContain('Initiatives') would also match unrelated nav copy.
    expect(html).toContain('Initiatives · 1 grinding · 1 stuck');
    expect(html).toMatch(/<a[^>]*href="\/app\/initiatives"/);
    expect(html).toContain(`data-testid="${PULSE_LINE_TESTID}"`);
  });

  it('deep-links to the sole contributing arc and leads with its title (AC-3)', () => {
    const html = renderToStaticMarkup(
      <InitiativePulseLine items={[arc('i-1', 'Alpha', 'losing'), arc('i-2', 'Beta', 'winning')]} />,
    );
    expect(html).toContain('Alpha · 1 losing');
    expect(html).toMatch(/<a[^>]*href="\/app\/initiatives\/i-1"/);
  });

  it('renders "ready to close" for a terminal-but-open arc (AC-4)', () => {
    const html = renderToStaticMarkup(
      <InitiativePulseLine items={[arc('i-1', 'Alpha', 'won_unclaimed')]} />,
    );
    expect(html).toContain('Alpha · 1 ready to close');
  });
});

/**
 * Migration step 5 replaces `InitiativeRail` with this line, so Home must
 * actually mount it — a component nothing renders is the failure mode the
 * deletion half already produced. Source-level, like `home-initiative-rail.test.ts`:
 * Home is an async server component with live DB reads.
 */
describe('Home mounts the pulse line (§2.1)', () => {
  const source = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

  it('imports and mounts InitiativePulseLine', () => {
    expect(source).toContain("from './InitiativePulseLine'");
    expect(source).toMatch(/<InitiativePulseLine\s/);
  });

  it('feeds it verdicts from the shared loader rather than a second query', () => {
    expect(source).toContain('deriveInitiativeVerdict');
    expect(source).toContain('loadInitiativeVerdictInputs');
    expect(source).toContain('loadInitiativeEffort');
  });

  it('mounts it between the greeting block and Waiting on You (§2.1)', () => {
    const greeting = source.indexOf('<Greeting firstName');
    const mount = source.indexOf('<InitiativePulseLine');
    const waiting = source.indexOf('Waiting on You — unified action queue');
    expect(greeting).toBeGreaterThan(-1);
    expect(waiting).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(greeting);
    expect(mount).toBeLessThan(waiting);
  });
});
