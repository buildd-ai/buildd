import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard for the backfill that undoes 0188's "chat off for teams that already
 * held a key". Chat is on whenever a key resolves; the only control is an
 * admin's kill switch, so the backfill may turn chat ON and never OFF, and only
 * for teams nobody edited since 0188 was generated (an edit since then may be an
 * admin switching chat off). No live Postgres in the unit suite, so this pins
 * the SQL. Found by content, so a renumber on an index collision keeps it green.
 */

const DRIZZLE = join(import.meta.dir, '..', 'drizzle');

function findMigration(): { file: string; sql: string } {
  const hits = readdirSync(DRIZZLE)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, sql: readFileSync(join(DRIZZLE, f), 'utf8') }))
    .filter((m) => /UPDATE\s+"teams"[\s\S]*SET\s+"chat_disabled"\s*=\s*false/i.test(m.sql));
  if (hits.length !== 1) throw new Error(`expected one chat-on backfill, found ${hits.length}`);
  return hits[0]!;
}

function journalWhen(tag: string): number {
  const j = JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  const e = j.entries.find((x) => x.tag === tag);
  if (!e) throw new Error(`no journal entry ${tag}`);
  return e.when;
}

describe('chat-on backfill', () => {
  const { file, sql } = findMigration();

  it('runs after 0188', () => {
    expect(Number(file.slice(0, 4))).toBeGreaterThan(188);
  });

  it('only turns chat on, and only where it is off', () => {
    expect(sql).not.toMatch(/SET\s+"chat_disabled"\s*=\s*true/i);
    expect(sql).toMatch(/"chat_disabled"\s*=\s*true\s/i);
  });

  it('spares every team edited since 0188 was generated', () => {
    const m = /"updated_at"\s*<\s*to_timestamp\(([\d.]+)\)/.exec(sql);
    expect(m).not.toBeNull();
    expect(Math.round(Number(m![1]) * 1000)).toBe(journalWhen('0188_flippant_jane_foster'));
  });

  it('needs a stored key, with the same purposes 0188 matched', () => {
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM "secrets"/i);
    expect(sql).toContain(`s."purpose" IN ('inference_key', 'anthropic_api_key', 'decision_key')`);
  });
});
