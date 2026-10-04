/**
 * Versioned prompts against real Postgres: the loader reads only active rows,
 * the partial unique index allows one active version per id, and a version
 * switch is picked up on the next load. A mocked `db` sees none of this.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { resetPrompts, resolvePrompt } from '@buildd/core/prompts';
import { loadPrompts, promptContentHash, resetPromptsLoader } from '@buildd/core/prompts-source';
import { assertDbConfigured, q } from './harness';

const id = `test.prompt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

async function insert(version: number, body: string, active: boolean) {
  await q(sql`INSERT INTO prompts (id, version, content_hash, body, active)
    VALUES (${id}, ${version}, ${promptContentHash(body)}, ${body}, ${active})`);
}

beforeAll(() => {
  assertDbConfigured();
  resetPrompts();
  resetPromptsLoader();
});
afterAll(async () => {
  await q(sql`DELETE FROM prompts WHERE id = ${id}`);
  resetPrompts();
});

describe('prompts table', () => {
  test('no row: the public default', async () => {
    await loadPrompts({ force: true });
    expect(resolvePrompt(id, 'public')).toBe('public');
  });

  test('an inactive row is not read; an active one is', async () => {
    await insert(1, 'first', false);
    await loadPrompts({ force: true });
    expect(resolvePrompt(id, 'public')).toBe('public');
    await q(sql`UPDATE prompts SET active = true WHERE id = ${id} AND version = 1`);
    await loadPrompts({ force: true });
    expect(resolvePrompt(id, 'public')).toBe('first');
  });

  test('at most one active version per id', async () => {
    let err: unknown = null;
    try {
      await insert(2, 'second', true);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
  });

  test('(id, version) is unique', async () => {
    let err: unknown = null;
    try {
      await insert(1, 'again', false);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
  });

  test('a version switch is picked up on the next load', async () => {
    await insert(2, 'second', false);
    // Deactivate first: the partial unique index is checked per row, not per statement.
    await q(sql`UPDATE prompts SET active = false WHERE id = ${id} AND version = 1`);
    await q(sql`UPDATE prompts SET active = true WHERE id = ${id} AND version = 2`);
    await loadPrompts({ force: true });
    expect(resolvePrompt(id, 'public')).toBe('second');
  });
});
