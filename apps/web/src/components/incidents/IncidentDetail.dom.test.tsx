/**
 * The incident page body in a browser (happy-dom), once per recovery state of
 * the dev fixture: it renders, says the projection's words, and offers typed
 * options only for a decision. Layout is checked by the Visual QA shots.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures?state=home-cards&data=incident-decision' });

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/app/dev/fixtures',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const { default: IncidentStatesFixture, INCIDENT_FIXTURE_CASES } = await import('@/app/app/dev/fixtures/IncidentStatesFixture');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function render(which: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<IncidentStatesFixture which={which} />));
  return host;
}

describe('incident page states', () => {
  for (const c of [...Object.keys(INCIDENT_FIXTURE_CASES), 'surfaces']) {
    test(`${c} renders`, () => {
      const el = render(c);
      expect(el.textContent?.length ?? 0).toBeGreaterThan(50);
      if (c !== 'surfaces') {
        expect(el.querySelector('[data-testid="incident-state"]')).not.toBeNull();
        expect(el.querySelector('[data-testid="incident-back"]')?.getAttribute('href')).toBe('/app/home');
        expect(!!el.querySelector('[data-testid="incident-options"]')).toBe(c === 'decision');
        if (c !== 'recovered') expect(el.textContent).not.toMatch(/Nothing is fixing|\bfixed\b|\bresolved\b/i);
      }
    });
  }
});
