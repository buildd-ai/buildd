import { describe, it, expect, mock } from 'bun:test';

// `deriveVerdict` lives in the loader module, which imports the database. Stub
// the db/schema/orm modules so importing it never opens a connection — the same
// shape `initiative-pulse.test.ts` uses. Only the pure ladder is exercised here;
// it is imported rather than restated because the pulse line MUST NOT re-derive
// a verdict of its own (§6.2, "one loader, three callers").
mock.module('@buildd/core/db', () => ({ db: { select: () => { throw new Error('not used'); } } }));
mock.module('@buildd/core/db/schema', () => ({
  workers: {}, tasks: {}, missions: {}, initiatives: {},
}));
mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ a, b }),
  and: (...args: any[]) => args,
  gte: (a: any, b: any) => ({ a, b }),
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
}));

import { buildInitiativePulseLine, type PulseLineItem } from './initiative-pulse-line';
import { deriveVerdict } from './initiative-pulse';
import type { Verdict } from './verdict-presentation';

function arc(id: string, title: string, verdict: Verdict): PulseLineItem {
  return { id, title, verdict };
}

describe('buildInitiativePulseLine — Home pulse line (spec §2.2)', () => {
  it('returns null when every arc is winning, dormant or empty (AC-1)', () => {
    const line = buildInitiativePulseLine([
      arc('i-1', 'Alpha', 'winning'),
      arc('i-2', 'Beta', 'dormant'),
      arc('i-3', 'Gamma', 'empty'),
    ]);
    expect(line).toBeNull();
  });

  it('returns null for an empty team', () => {
    expect(buildInitiativePulseLine([])).toBeNull();
  });

  it('reads "Initiatives · 1 grinding · 1 stuck" and links to the list (AC-2)', () => {
    const line = buildInitiativePulseLine([
      arc('i-1', 'Alpha', 'grinding'),
      arc('i-2', 'Beta', 'stuck'),
    ]);
    expect(line?.text).toBe('Initiatives · 1 grinding · 1 stuck');
    expect(line?.href).toBe('/app/initiatives');
  });

  it('prefixes the single contributing arc and deep-links to it (AC-3)', () => {
    const line = buildInitiativePulseLine([
      arc('i-1', 'Alpha', 'losing'),
      arc('i-2', 'Beta', 'winning'),
      arc('i-3', 'Gamma', 'dormant'),
    ]);
    expect(line?.text).toBe('Alpha · 1 losing');
    expect(line?.href).toBe('/app/initiatives/i-1');
  });

  it('keeps "Initiatives" when one arc contributes several clauses only if it is the sole contributor', () => {
    // Two arcs, both contributing → generic prefix and list link.
    const two = buildInitiativePulseLine([
      arc('i-1', 'Alpha', 'losing'),
      arc('i-2', 'Alpha', 'stuck'),
    ]);
    expect(two?.text).toBe('Initiatives · 1 losing · 1 stuck');
    expect(two?.href).toBe('/app/initiatives');
  });

  it('counts a terminal-but-open arc as "1 ready to close" (AC-4)', () => {
    // The ladder's own answer for "every child mission terminal, DB status active".
    const verdict = deriveVerdict({
      status: 'active',
      totalMissions: 3,
      allTerminal: true,
      criteriaFail: 0,
      merges7d: 0,
      attempts7d: 0,
      tokens7d: 0,
      held: 0,
      blocked: 0,
      awaitingVerification: 0,
    });
    expect(verdict).toBe('won_unclaimed');

    const line = buildInitiativePulseLine([arc('i-1', 'Alpha', verdict)]);
    expect(line?.text).toBe('Alpha · 1 ready to close');
  });

  it('orders clauses losing → grinding → stuck → ready to close and omits zeros', () => {
    const line = buildInitiativePulseLine([
      arc('i-4', 'Delta', 'won_unclaimed'),
      arc('i-3', 'Gamma', 'stuck'),
      arc('i-1', 'Alpha', 'losing'),
      arc('i-5', 'Epsilon', 'winning'),
      arc('i-2', 'Beta', 'losing'),
    ]);
    // No `grinding` arc → no grinding clause at all.
    expect(line?.text).toBe('Initiatives · 2 losing · 1 stuck · 1 ready to close');
    expect(line?.clauses).toEqual(['2 losing', '1 stuck', '1 ready to close']);
  });

  it('never counts a PR that sits in the Waiting-on-You queue (AC-5)', () => {
    // An arc with three completed tasks whose PRs are open is exactly three
    // MERGE cards in the queue below the line. The ladder reads it as one arc…
    const verdict = deriveVerdict({
      status: 'active',
      totalMissions: 2,
      allTerminal: false,
      criteriaFail: 0,
      merges7d: 0,
      attempts7d: 0,
      tokens7d: 0,
      held: 0,
      blocked: 0,
      awaitingVerification: 3,
    });
    expect(verdict).toBe('stuck');

    // …and the clause counts arcs, so the number is 1, never 3, and the word
    // "awaiting merge" never appears (§2.3).
    const line = buildInitiativePulseLine([arc('i-1', 'Alpha', verdict)]);
    expect(line?.text).toBe('Alpha · 1 stuck');
    expect(line?.text).not.toContain('3');
    expect(line?.text).not.toContain('awaiting');

    // And an arc that is merging while a PR waits in the queue contributes
    // nothing at all — the queue owns that row.
    const winning = deriveVerdict({
      status: 'active',
      totalMissions: 2,
      allTerminal: false,
      criteriaFail: 0,
      merges7d: 2,
      attempts7d: 1,
      tokens7d: 5000,
      held: 0,
      blocked: 0,
      awaitingVerification: 1,
    });
    expect(winning).toBe('winning');
    expect(buildInitiativePulseLine([arc('i-1', 'Alpha', winning)])).toBeNull();
  });

  it('is non-mutating and order-independent', () => {
    const items = [arc('i-2', 'Beta', 'stuck'), arc('i-1', 'Alpha', 'losing')];
    const snapshot = JSON.stringify(items);
    buildInitiativePulseLine(items);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});
