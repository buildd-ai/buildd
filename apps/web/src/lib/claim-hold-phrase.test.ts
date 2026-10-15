// Spec 8e137fdb AC-10: every claim-gate hold has wording; AC-9: an unknown one invents no cause.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAIM_HOLD_PHRASES, claimHoldPhrase } from './claim-hold-phrase';

const ROUTE = join(import.meta.dir, '../app/api/workers/claim/route.ts');

/** The claim route's own `deferrals` counters: the reasons it can record. */
function claimRouteDeferralKeys(): string[] {
  const src = readFileSync(ROUTE, 'utf8');
  const block = /const deferrals = \{([\s\S]*?)\} satisfies/.exec(src)?.[1];
  if (!block) throw new Error('could not find the deferrals counters in the claim route');
  return [...block.matchAll(/^\s*([a-z_]+):\s*0,/gm)].map(m => m[1]);
}

describe('claim hold wording', () => {
  it('every reason the claim route can record has wording', () => {
    const keys = claimRouteDeferralKeys();
    expect(keys.length).toBeGreaterThan(10);
    const missing = keys.filter(k => !claimHoldPhrase(k));
    expect(missing, `claim-gate holds with no wording in claim-hold-phrase.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('no wording for a reason the route no longer records', () => {
    const keys = new Set(claimRouteDeferralKeys());
    expect(Object.keys(CLAIM_HOLD_PHRASES).filter(k => !keys.has(k))).toEqual([]);
  });

  it('an unknown reason has no wording', () => {
    expect(claimHoldPhrase('something_new')).toBeNull();
    expect(claimHoldPhrase('toString')).toBeNull();
    expect(claimHoldPhrase(null)).toBeNull();
  });
});
