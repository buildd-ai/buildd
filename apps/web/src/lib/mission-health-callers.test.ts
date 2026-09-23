import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Source-scan guards for the mission-health inputs. These are server
// components that pull in the DB client, so the wiring is asserted on source.
//
// `deriveMissionHealth` only reaches 'escalated' when the caller affirmatively
// passes `hasPendingDeliverableWork`. The list surfaces used to pass
// `criteriaEscalatedAt` without it, so 'escalated' was reachable only on the
// mission detail page. This fails the moment a surface drops it again.

const APP_ROOT = join(import.meta.dir, '..', 'app');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function callArgs(src: string, fn: string): string[] {
  const calls: string[] = [];
  let i = src.indexOf(`${fn}(`);
  while (i !== -1) {
    let depth = 0;
    let j = i + fn.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) break;
    }
    calls.push(src.slice(i, j + 1));
    i = src.indexOf(`${fn}(`, j);
  }
  return calls;
}

const files = walk(APP_ROOT);

describe('deriveMissionHealth call sites', () => {
  it('the scan finds the known list surfaces (it is not vacuously green)', () => {
    const callers = files.filter(f => readFileSync(f, 'utf8').includes('deriveMissionHealth({'));
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const call of callArgs(src, 'deriveMissionHealth')) {
      if (!call.includes('criteriaEscalatedAt')) continue;
      it(`${relative(APP_ROOT, file)} passes hasPendingDeliverableWork alongside criteriaEscalatedAt`, () => {
        expect(call).toContain('hasPendingDeliverableWork');
      });
    }
  }
});

describe('team role page counts live agents from worker statuses', () => {
  const src = readFileSync(join(APP_ROOT, 'app', '(protected)', 'team', '[slug]', 'page.tsx'), 'utf8');

  it("never counts a task status 'running' (tasks have no such status)", () => {
    expect(src).not.toMatch(/\.filter\(\s*t\s*=>\s*t\.status\s*===\s*'running'/);
  });

  it('loads worker statuses under mission tasks and counts live workers', () => {
    expect(src).toMatch(/workers:\s*\{\s*columns:\s*\{\s*status:\s*true/);
    expect(src).toMatch(/LIVE_WORKER_STATUSES[^;]*\.includes\(w\.status\)/);
  });
});

describe('mission detail header chip reads the shared state view', () => {
  const src = readFileSync(join(APP_ROOT, 'app', '(protected)', 'missions', '[id]', 'page.tsx'), 'utf8');

  it('display state and chip come from the explain answer, with the old chain only as fallback', () => {
    expect(src).toContain('missionAnswer?.displayState ??');
    expect(src).toContain('missionAnswer?.chip ??');
  });

  it('the explain answer is awaited before the chip is derived', () => {
    expect(src.indexOf('explainMission(id)')).toBeLessThan(src.indexOf('const stateChip'));
  });
});
