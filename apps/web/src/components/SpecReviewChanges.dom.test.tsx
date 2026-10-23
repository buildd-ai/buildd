/**
 * Review's change list, mounted (happy-dom): "Reviewing a spec revision"
 * AC-10 to AC-13 — a lightly edited criterion keeps inline marks, a mostly
 * rewritten one reads as Was and Now, inline code and emphasis render with
 * no raw backtick in any view, and a row is one column at phone width.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/specs/s1' });

import { afterEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecReviewChanges } = await import('./SpecReviewChanges');
const { criterionChanges, changeLines } = await import('@buildd/spec-contract/criterion-review');

const rec = (id: string, text: string) => ({ id, text, textHash: text, section: 'Requirements', replaces: [] });
const mount = (from: string, to: string, extra: { added?: string } = {}) => {
  const lines = changeLines(criterionChanges([rec('R-1', from)], [rec('R-1', to), ...(extra.added ? [rec('R-2', extra.added)] : [])]));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(<SpecReviewChanges summary="s" lines={lines} otherText={[]} mismatch={null} />); });
  return { host, root };
};
let mounted: ReturnType<typeof mount> | null = null;
afterEach(() => { if (mounted) { act(() => mounted!.root.unmount()); mounted.host.remove(); mounted = null; } });

describe('SpecReviewChanges criterion text', () => {
  it('AC-10: a small edit stays inline, no Was/Now', () => {
    mounted = mount('The panel lists every changed criterion by id today.', 'The panel lists every changed criterion by id now.');
    expect(mounted.host.querySelector('[data-testid="spec-review-was-now"]')).toBeNull();
    expect(mounted.host.querySelectorAll('[data-testid="spec-review-word-added"]').length).toBe(1);
    expect(mounted.host.querySelectorAll('[data-testid="spec-review-word-removed"]').length).toBe(1);
  });

  it('AC-11: a mostly rewritten criterion reads as Was (not struck) and Now (added highlighted)', () => {
    mounted = mount('Every removed word is struck out in red inline.', 'A wholly different sentence says something else entirely.');
    const was = mounted.host.querySelector('[data-testid="spec-review-was"]')!;
    const now = mounted.host.querySelector('[data-testid="spec-review-now"]')!;
    expect(was.textContent).toContain('Every removed word is struck out in red inline.');
    expect(was.querySelector('del')).toBeNull();
    expect(now.textContent).toContain('A wholly different sentence says something else entirely.');
    expect(now.querySelector('ins')).not.toBeNull();
    expect(mounted.host.querySelectorAll('[data-testid="spec-review-word-removed"]').length).toBe(0);
  });

  it('AC-12: inline code and emphasis render in inline, Was/Now and added views; no backtick shows', () => {
    mounted = mount('Use `alpha` for **old** things in the list.', 'Use `beta` for *new* things in the list.');
    expect(mounted.host.querySelectorAll('code').length).toBeGreaterThan(0);
    mounted.root.unmount();
    mounted.host.remove();
    mounted = mount('plain words here', 'Nothing like `before` at all; **bold** claims.', { added: 'Added `thing` here.' });
    expect(mounted.host.querySelector('[data-testid="spec-review-was-now"]')).not.toBeNull();
    expect(mounted.host.querySelector('[data-testid="spec-review-now"] code')?.textContent).toBe('before');
    expect(mounted.host.textContent).not.toContain('`');
    expect(mounted.host.textContent).not.toContain('*');
  });

  it('AC-13: a row is one column at phone width, the grid only from md', () => {
    mounted = mount('Old text of the criterion.', 'New text of the criterion.');
    const row = mounted.host.querySelector('[data-testid="spec-review-change"]')!;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('md:grid');
    expect(row.querySelector('[data-testid="spec-review-change-id"]')?.parentElement?.className).toContain('flex');
  });
});
