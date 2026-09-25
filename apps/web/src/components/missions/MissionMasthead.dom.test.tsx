/**
 * MissionMasthead, mounted (happy-dom). The sticky size is rendered by a
 * client component but its `verified` / `actions` / `expand` slots arrive as
 * React elements from the server page. An outlined Flight chunk arrives as a lazy
 * node around an unvalidated element, and placed bare in a JSX children array
 * it tripped React's
 * "Each child in a list should have a unique key" warning on every mission
 * page. Fixtures are illustrative.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { deriveMissionStateView } = await import('@/lib/mission-state-view');
const { buildPulseSegments } = await import('@/lib/mission-pulse');
const { default: MissionMasthead } = await import('./MissionMasthead');

/**
 * A server element as the Flight client can hand it over: an outlined chunk is
 * a lazy node wrapping an element that was never key-validated (`validated: 0`,
 * no key). `jsxs` only validates real elements, so a bare lazy in a children
 * array reaches the reconciler's key check.
 */
function serverElement(type: string, text: string): React.ReactElement {
  const el = React.createElement(type, null, text) as unknown as { _store: { validated: number } };
  el._store.validated = 0;
  return {
    $$typeof: Symbol.for('react.lazy'),
    _payload: el,
    _init: (payload: unknown) => payload,
    _store: { validated: 0 },
  } as unknown as React.ReactElement;
}

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let errors: string[];
const realError = console.error;

beforeEach(() => {
  errors = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  console.error = realError;
});

const segments = buildPulseSegments([
  { id: 'a', title: 'Task a', status: 'completed', taskClass: 'work', createdAt: new Date(1) },
  { id: 'b', title: 'Task b', status: 'pending', taskClass: 'work', createdAt: new Date(2) },
]);
const chip = deriveMissionStateView({ status: 'active', isHeld: false, activeAgents: 1, health: 'NOMINAL' } as never).chip;

describe('MissionMasthead slots from the server', () => {
  for (const size of ['sticky', 'card'] as const) {
    it(`${size}: renders server-provided slots without a missing-key warning`, () => {
      act(() => {
        root.render(
          <MissionMasthead
            size={size}
            title="Ship the thing"
            chip={chip}
            segments={segments}
            caption="1/2"
            href="/app/missions/m1"
            back={{ label: 'Missions', href: '/app/missions' }}
            verified={serverElement('span', 'Verified')}
            actions={serverElement('button', '⋮')}
            expand={serverElement('button', '⤢')}
          />,
        );
      });
      expect(container.textContent).toContain('⋮');
      expect(container.textContent).toContain('⤢');
      expect(errors.filter(e => e.includes('unique "key"'))).toEqual([]);
    });
  }
});
