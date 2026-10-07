/**
 * Next.js compiles instrumentation.ts separately from the route handlers, so a
 * module it imports can exist twice in one server process. The boot load
 * installs the snapshot into instrumentation's copy; a route reads its own.
 * Regression: production ran every prompt on its public default while the
 * prompts table held active rows, because the routes' copy was never filled.
 *
 * A query string makes Bun load a separate module instance, which is exactly
 * the two-bundle situation.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROMPTS = fileURLToPath(new URL('../prompts.ts', import.meta.url));
const SNAPSHOT = fileURLToPath(new URL('../runtime-snapshot.ts', import.meta.url));

type PromptsModule = typeof import('../prompts');
type SnapshotModule = typeof import('../runtime-snapshot');

let n = 0;
async function copyOf<M>(href: string): Promise<M> {
  n += 1;
  return (await import(`${href}?copy=${n}`)) as M;
}

const body = 'private text';
const row = { id: 'test.shared', version: 3, body, contentHash: createHash('sha256').update(body).digest('hex') };

afterEach(async () => {
  (await copyOf<PromptsModule>(PROMPTS)).resetPrompts();
});

describe('one snapshot per process, across module copies', () => {
  it('loads two distinct copies (precondition)', async () => {
    const a = await copyOf<PromptsModule>(PROMPTS);
    const b = await copyOf<PromptsModule>(PROMPTS);
    expect(a.resolvePrompt).not.toBe(b.resolvePrompt);
  });

  it('a prompt installed through one copy resolves through another', async () => {
    const boot = await copyOf<PromptsModule>(PROMPTS);
    const route = await copyOf<PromptsModule>(PROMPTS);
    boot.installPrompts([row]);
    expect(route.resolvePrompt('test.shared', 'public default')).toBe('private text');
    expect(route.activePromptFingerprints()).toEqual([{ id: row.id, version: row.version, contentHash: row.contentHash }]);
  });

  it('a refresher registered by the boot copy is poked by a route read', async () => {
    const boot = await copyOf<PromptsModule>(PROMPTS);
    const route = await copyOf<PromptsModule>(PROMPTS);
    let pokes = 0;
    boot.promptsSnapshot.setRefresher(() => {
      pokes += 1;
    });
    route.resolvePrompt('test.unknown', 'public default');
    expect(pokes).toBe(1);
  });

  it('fallbacks counted in one copy are reported by another, and reach the boot listener', async () => {
    const boot = await copyOf<PromptsModule>(PROMPTS);
    const route = await copyOf<PromptsModule>(PROMPTS);
    const report = await copyOf<PromptsModule>(PROMPTS);
    const heard: string[] = [];
    boot.setPromptFallbackListener((id, reason) => heard.push(`${id}:${reason}`));
    route.resolvePrompt('test.missing', 'public default');
    expect(report.promptFallbackCounts()).toEqual({ 'test.missing': { missing: 1, invalid: 0 } });
    expect(heard).toEqual(['test.missing:missing']);
  });

  it('reset through any copy clears the shared state', async () => {
    const a = await copyOf<PromptsModule>(PROMPTS);
    const b = await copyOf<PromptsModule>(PROMPTS);
    a.installPrompts([row]);
    b.resetPrompts();
    expect(a.activePromptFingerprints()).toEqual([]);
  });
});

describe('createRuntimeSnapshot sharedKey', () => {
  it('shares value and refresher between copies of runtime-snapshot itself', async () => {
    const a = await copyOf<SnapshotModule>(SNAPSHOT);
    const b = await copyOf<SnapshotModule>(SNAPSHOT);
    const key = `test.snapshot.${Math.random()}`;
    const sa = a.createRuntimeSnapshot(0, { sharedKey: key });
    const sb = b.createRuntimeSnapshot(0, { sharedKey: key });
    let pokes = 0;
    sa.setRefresher(() => {
      pokes += 1;
    });
    sa.install(7);
    expect(sb.read()).toBe(7);
    expect(pokes).toBe(1);
    sb.reset();
    expect(sa.peek()).toBe(0);
  });

  it('keeps an unkeyed snapshot private', async () => {
    const { createRuntimeSnapshot } = await copyOf<SnapshotModule>(SNAPSHOT);
    const sa = createRuntimeSnapshot(0);
    const sb = createRuntimeSnapshot(0);
    sa.install(5);
    expect(sb.peek()).toBe(0);
  });
});
