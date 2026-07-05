import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Server components cannot pass event handlers to DOM elements — doing so
 * throws "Event handlers cannot be passed to Client Component props" at
 * render time and trips the route's error boundary ("Something went wrong").
 * This happened in prod on /app/missions/[id] and /app/team/[slug] via
 * <a onClick={stopPropagation}> PR links. Interactive bits belong in a
 * 'use client' component (e.g. components/ExternalLink.tsx).
 */

const APP_DIR = join(import.meta.dir, '..', 'app');

function collectPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectPages(full, out);
    else if (entry.name === 'page.tsx' || entry.name === 'layout.tsx') out.push(full);
  }
  return out;
}

describe('server components must not attach event handlers', () => {
  it('no page/layout without "use client" contains an inline event handler prop', () => {
    const offenders: string[] = [];
    for (const file of collectPages(APP_DIR)) {
      const src = readFileSync(file, 'utf8');
      const isClient = /^\s*['"]use client['"]/.test(src);
      if (isClient) continue;
      if (/\bon(Click|Change|Submit|KeyDown|Focus|Blur)=\{/.test(src)) {
        offenders.push(file.replace(APP_DIR, 'src/app'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
