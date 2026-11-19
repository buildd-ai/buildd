/**
 * The bundled tier defaults (packages/ai-kit/src/policy/defaults.ts, read
 * through bundledTierEntry) are the LAST resort: a team with registry rows, a
 * platform default, or a reachable catalog never sees them. They still ship
 * in the runner's sync fallback and in every cold start, and they went stale
 * silently before (standard sat on an older, dearer Sonnet for months).
 *
 * This pins them to the newest model buildd has already certified in the same
 * family: a row in MODEL_MIN_CLI_VERSION (model-capability-requirements.ts) is
 * a model the fleet is known to launch, so a default older than that row is
 * drift nobody chose. Adding a floor row for a new release therefore fails
 * here until the default moves with it, which is the point: the two cannot
 * drift apart by more than one commit. Offline on purpose: no catalog, no DB.
 */
import { describe, it, expect } from 'bun:test';
import { TIERS, bundledTierEntry } from '../model-tier-defaults';
import { MODEL_MIN_CLI_VERSION } from '../model-capability-requirements';
import { parseAnthropicModelId } from '../model-tier-liveness';

function newestCertifiedInFamily(family: string): { id: string; major: number; minor: number } | null {
  let best: { id: string; major: number; minor: number } | null = null;
  for (const id of Object.keys(MODEL_MIN_CLI_VERSION)) {
    const p = parseAnthropicModelId(id);
    if (!p || p.family !== family) continue;
    if (!best || p.major > best.major || (p.major === best.major && p.minor > best.minor)) best = { id, major: p.major, minor: p.minor };
  }
  return best;
}

describe('bundled tier defaults do not drift behind the certified floor table', () => {
  for (const tier of TIERS) {
    it(`${tier} is on the newest certified model of its family`, () => {
      const entry = bundledTierEntry(tier);
      expect(entry.provider).toBe('anthropic');
      const mine = parseAnthropicModelId(entry.model);
      expect(mine).not.toBeNull();
      const newest = newestCertifiedInFamily(mine!.family);
      // A family the table never names has nothing to compare against.
      if (!newest) return;
      const behind = newest.major > mine!.major || (newest.major === mine!.major && newest.minor > mine!.minor);
      expect({ tier, default: entry.model, newestCertified: newest.id, behind }).toEqual({ tier, default: entry.model, newestCertified: newest.id, behind: false });
    });
  }

  it('can fail: a default a minor version behind its family is caught', () => {
    const newest = newestCertifiedInFamily('haiku');
    expect(newest).not.toBeNull();
    const olderMinor = { family: 'haiku', major: newest!.major, minor: newest!.minor - 1 };
    const behind = newest!.major > olderMinor.major || (newest!.major === olderMinor.major && newest!.minor > olderMinor.minor);
    expect(behind).toBe(true);
  });
});
