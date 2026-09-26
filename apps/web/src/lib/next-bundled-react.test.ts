import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Guards a property of the React build that Next BUNDLES (next/dist/compiled),
 * not of anything in this repo: a Suspense ping that lands while React is
 * rendering must be recorded, not dropped.
 *
 * Why it matters here: /app/home re-renders on live events via router.refresh().
 * Its RSC payload is large enough that Flight defers sections into lazy rows
 * (any row past 3200 serialized bytes). When the refresh transition reads a row
 * that has arrived but is not yet parsed, the Flight client initialises it on
 * the spot and calls its listeners synchronously — i.e. it pings the root from
 * inside render. The React canary bundled with Next 16.2.10
 * (19.3.0-canary-3f0b9e61-20260317) handled that ping with
 *
 *     ? 0 === (executionContext & 2) && prepareFreshStack(root, 0)
 *
 * so when the in-progress render had already exited RootSuspendedWithDelay the
 * ping was neither restarted nor merged into workInProgressRootPingedLanes. The
 * root kept its transition lanes suspended with nothing left to wake it: the
 * refetch completed, and the screen never changed until a full reload. Later
 * canaries (Next 16.3.x) record the ping in that branch.
 *
 * A Next bump always changes bun.lock, which runs the whole suite, so this
 * catches a regression the moment the dependency moves. The end-to-end version
 * of the same property is scripts/demo/check-live-refresh.ts.
 */

const WEB_ROOT = join(import.meta.dir, '..', '..');

function bundledReactDomClient(): string {
  const nextPkg = require.resolve('next/package.json', { paths: [WEB_ROOT] });
  return readFileSync(
    join(dirname(nextPkg), 'dist/compiled/react-dom/cjs/react-dom-client.production.js'),
    'utf8',
  );
}

/** Source of `function name(...) { ... }`, by brace matching; null if absent. */
function functionSource(src: string, name: string): string | null {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/**
 * True when pingSuspendedRoot can drop a ping that arrives during render: the
 * render-context guard short-circuits (`&&`) with no branch that records the
 * pinged lanes.
 */
function dropsPingDuringRender(pingSuspendedRoot: string): boolean {
  const flat = pingSuspendedRoot.replace(/\s+/g, '');
  return flat.includes('0===(executionContext&2)&&prepareFreshStack(root,0)');
}

describe('React bundled with Next: a ping during render is not dropped', () => {
  it('detects the dropping shape, and accepts the fixed one', () => {
    const broken = `function pingSuspendedRoot(root, wakeable, pingedLanes) {
      workInProgressRoot === root &&
        (4 === workInProgressRootExitStatus
          ? 0 === (executionContext & 2) && prepareFreshStack(root, 0)
          : (workInProgressRootPingedLanes |= pingedLanes));
    }`;
    const fixed = `function pingSuspendedRoot(root, wakeable, pingedLanes) {
      workInProgressRoot === root &&
        (4 === workInProgressRootExitStatus
          ? 0 === (executionContext & 2)
            ? prepareFreshStack(root, 0)
            : (workInProgressRootPingedLanes |= pingedLanes)
          : (workInProgressRootPingedLanes |= pingedLanes));
    }`;
    expect(dropsPingDuringRender(functionSource(broken, 'pingSuspendedRoot')!)).toBe(true);
    expect(dropsPingDuringRender(functionSource(fixed, 'pingSuspendedRoot')!)).toBe(false);
  });

  it('the installed next ships a react-dom that records it', () => {
    const src = functionSource(bundledReactDomClient(), 'pingSuspendedRoot');
    // If React renames this, re-derive the check rather than deleting it.
    expect(src).not.toBeNull();
    expect(src!).toContain('workInProgressRootPingedLanes');
    expect(dropsPingDuringRender(src!)).toBe(false);
  });
});
