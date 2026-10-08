/**
 * The sign-in page is the first buildd screen a stranger sees after
 * "Start free" on buildd.dev. It says the site's line and uses the app's own
 * brand (square card, ink border, hard shadow), not a blurred glass card.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next-auth/react', () => ({ signIn: () => {} }));
mock.module('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));

const { renderToString } = await import('react-dom/server');
const { default: SignInPage } = await import('./page');
const { TAGLINE_LEAD, TAGLINE_TAIL } = await import('./tagline');

describe('sign-in page', () => {
  const html = renderToString(<SignInPage />);

  it("says the site's line", () => {
    expect(`${TAGLINE_LEAD} ${TAGLINE_TAIL}`).toBe("Agents say they're done. buildd checks.");
    expect(html).toContain('buildd checks.');
    expect(html).not.toContain('AI Dev Team Orchestration');
  });

  it('uses the brand surface, not glass', () => {
    expect(html).toContain('class="card');
    expect(html).not.toMatch(/(?:bg|text|border)-\[#[0-9a-f]{6}\]/i);
    expect(html).not.toMatch(/backdrop-blur|blur-sm|rounded-2xl|bg-white\/10/);
  });
});
