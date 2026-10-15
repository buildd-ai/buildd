/**
 * The spec delivery fixture shows what Visual QA needs to see: mission entries
 * beside a task entry, in the page's own sentences, a waiver said with who
 * waived it, and nothing that reads as passed when it did not pass.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures' });

import { afterAll, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: SpecDeliveryFixture } = await import('./SpecDeliveryFixture');

describe('SpecDeliveryFixture', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  afterAll(() => act(() => root.unmount()));

  it('lists missions first, then the task, each with its standing', async () => {
    await act(async () => { root.render(<SpecDeliveryFixture />); });
    const rows = [...container.querySelectorAll('[data-testid="spec-delivery-entry"]')];
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['mission', 'mission', 'mission', 'task']);
    const standing = rows.map((r) => r.querySelector('[data-testid="spec-delivery-standing"]')!.textContent);
    expect(standing).toEqual([
      'Verified against revision 2. AC-2 waived by Ada Lovelace.',
      'AC-4 fails against revision 2.',
      'Not verified against revision 2.',
      'Passed on an older commit. Not verified against revision 2.',
    ]);
    expect(rows[0].querySelector('[data-testid="spec-delivery-link"]')!.getAttribute('href')).toBe('/app/missions/fixture-mission-euros');
    expect(container.textContent).not.toMatch(/not\b[^.]*\byet/i);
    expect(container.textContent).not.toContain('—');
  });
});
