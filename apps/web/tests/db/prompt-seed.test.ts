/**
 * The prompt seed's writes against real Postgres: insert + activate under the
 * one-active-per-id partial unique index, a re-run is a no-op, a new version
 * replaces the active one, a deactivation, and the seed marker round-trip.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { planPromptSeed, sha256Hex, type PromptSeedEntry } from '@buildd/core/prompt-seed';
import { applyPromptSeed, readPromptRows, readPromptSeedMarker, writePromptSeedMarker } from '@buildd/core/prompt-seed-source';
import { assertDbConfigured, q } from './harness';

const id = `test.seed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const entry = (version: number, body: string): PromptSeedEntry => ({ id, version, body, contentHash: sha256Hex(body) });
const mine = async () => (await readPromptRows()).filter(r => r.id === id).sort((a, b) => a.version - b.version);

let priorMarker: unknown = null;
beforeAll(async () => {
  assertDbConfigured();
  const [row] = await q<{ value: unknown }>(sql`SELECT value FROM system_cache WHERE key = 'prompts:seed'`);
  priorMarker = row?.value ?? null;
});
afterAll(async () => {
  await q(sql`DELETE FROM prompts WHERE id = ${id}`);
  if (priorMarker) await writePromptSeedMarker(priorMarker as never);
  else await q(sql`DELETE FROM system_cache WHERE key = 'prompts:seed'`);
});

describe('prompt seed writes', () => {
  test('a new version is inserted and active; a second run is a no-op', async () => {
    await applyPromptSeed(planPromptSeed([entry(1, 'one')], await mine()));
    expect((await mine()).map(r => [r.version, r.active])).toEqual([[1, true]]);
    const again = planPromptSeed([entry(1, 'one')], await mine());
    expect(again).toEqual([{ type: 'unchanged', id, version: 1 }]);
    await applyPromptSeed(again);
    expect((await mine()).map(r => [r.version, r.active])).toEqual([[1, true]]);
  });

  test('a changed file at a new version replaces the active row; the old one stays as history', async () => {
    await applyPromptSeed(planPromptSeed([entry(2, 'two')], await mine()));
    expect((await mine()).map(r => [r.version, r.active])).toEqual([[1, false], [2, true]]);
  });

  test('rolling back to an old version reactivates it without a new row', async () => {
    await applyPromptSeed(planPromptSeed([entry(1, 'one')], await mine()));
    expect((await mine()).map(r => [r.version, r.active])).toEqual([[1, true], [2, false]]);
  });

  test('deactivate leaves no active row', async () => {
    await applyPromptSeed([{ type: 'deactivate', id }]);
    expect((await mine()).some(r => r.active)).toBe(false);
  });

  test('the seed marker round-trips', async () => {
    await writePromptSeedMarker({ seededAt: '2026-01-01T00:00:00.000Z', ids: [id] });
    expect(await readPromptSeedMarker()).toEqual({ seededAt: '2026-01-01T00:00:00.000Z', ids: [id] });
  });
});
