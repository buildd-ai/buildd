import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every Pusher event this app publishes must either be consumed by a client
 * component or be declared server-only on purpose.
 *
 * Why this gate exists: `mission:completion_decision` was emitted for every
 * real completion decision, exactly as its spec required, and had **no
 * subscriber anywhere** — so the refusal code and reason lived only in the feed
 * and the server logs, and the page a reader opens to ask "why is this not
 * done" never updated when the answer changed. Nothing failed. A published
 * event with no consumer is indistinguishable from a working feature until
 * somebody notices the UI is stale.
 *
 * The allowlist is the point: making an event server-only has to be a written
 * decision with a reason, not the default that silence produces.
 */

// __dirname is apps/web/src/lib, so one level up is the tree we scan.
const webSrc = join(__dirname, '..');

/**
 * Events with no client consumer by design. Each entry states why, because an
 * unexplained allowlist is how a coverage gate stops measuring anything.
 */
const SERVER_ONLY_EVENTS: Record<string, string> = {
  // Commands travel server → runner over the worker channel; the dashboard is
  // not a party to them.
  'worker:command': 'runner control plane, not a UI signal',
  'task:assigned': 'runner claim routing; the UI learns via task:updated',
  // Schedule bookkeeping consumed by the cron/runner side.
  'schedule:triggered': 'cron bookkeeping; surfaced through the tasks it creates',
  'schedule:deferred': 'cron bookkeeping; surfaced through schedule state on reload',
  'task:dependency_failed': 'server-side chain unwinding; the failed task itself refreshes',
  'task:retry_cap': 'server-side loop breaker; the task row carries the outcome',
  'mission:loop_stalled': 'organizer diagnostics; mission health renders the state',
  'mission:cycle_started': 'organizer diagnostics; no per-cycle UI',
  'mission:loop_completed': 'organizer diagnostics; mission health renders the state',
  'mission:reopened': 'mission status change; picked up by the mission page reload',
  // NOTE: its sibling `worker:connector-auth-expired` DOES have a client
  // consumer (ConnectorReconnectProvider). This one does not, which is an
  // inconsistency worth closing rather than a deliberate design — a GitHub App
  // permission gap is just as actionable by the viewer as an expired token.
  'worker:connector-permission-insufficient': 'no reconnect surface exists for a permission gap yet',
};

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if ((full.endsWith('.ts') || full.endsWith('.tsx')) && !full.includes('.test.')) out.push(full);
  }
  return out;
}

/** The event string literals, read from the source of truth rather than imported. */
function publishedEvents(): string[] {
  const src = readFileSync(join(webSrc, 'lib/pusher.ts'), 'utf8');
  const block = src.slice(src.indexOf('export const events'), src.indexOf('} as const;', src.indexOf('export const events')));
  return [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
}

const files = collectFiles(webSrc);
/** Files that bind Pusher handlers — i.e. the consumer side. */
const clientSources = files
  .filter((f) => {
    const src = readFileSync(f, 'utf8');
    return src.includes('.bind(') && (src.includes('subscribeToChannel') || src.includes('pusher-client'));
  })
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('Pusher subscriber coverage', () => {
  // A gate over an empty set reports the same "0 problems" as a healthy one.
  it('found the event map and at least one subscribing client module', () => {
    expect(publishedEvents().length).toBeGreaterThan(10);
    expect(clientSources.length).toBeGreaterThan(0);
    expect(clientSources).toContain('.bind(');
  });

  it('every published event is either consumed by a client or declared server-only', () => {
    const orphans = publishedEvents().filter(
      (ev) => !(ev in SERVER_ONLY_EVENTS) && !clientSources.includes(`'${ev}'`),
    );
    expect(orphans).toEqual([]);
  });

  it('the server-only allowlist names no event that has since gained a subscriber', () => {
    // Keeps the allowlist honest in the other direction: an entry that is now
    // consumed is a stale exemption, and stale exemptions are how these lists rot.
    const stale = Object.keys(SERVER_ONLY_EVENTS).filter((ev) => clientSources.includes(`'${ev}'`));
    expect(stale).toEqual([]);
  });

  it('the server-only allowlist names no event that is no longer published', () => {
    const published = new Set(publishedEvents());
    const dead = Object.keys(SERVER_ONLY_EVENTS).filter((ev) => !published.has(ev));
    expect(dead).toEqual([]);
  });

  it('every server-only exemption carries a stated reason', () => {
    const unexplained = Object.entries(SERVER_ONLY_EVENTS)
      .filter(([, why]) => why.trim().length < 15)
      .map(([ev]) => ev);
    expect(unexplained).toEqual([]);
  });
});
