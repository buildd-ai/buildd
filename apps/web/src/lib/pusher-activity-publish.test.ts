import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

/**
 * worker:progress is never published on a worker or workspace channel.
 *
 * Every runner holds every workspace channel it can see, and each of its own
 * workers' channels, for task:* and the terminal worker events. Pusher bills a
 * delivery to every subscribed connection, so a progress tick there was billed
 * once per runner and thrown away by each. It goes to the channel's -activity
 * twin (channels.workerActivity / channels.workspaceActivity), which only the
 * dashboard subscribes to. Task channels have no runner subscriber and keep it.
 */
const webSrc = resolve(import.meta.dir, '..');

function callsIn(text: string): string[] {
  const out: string[] = [];
  const re = /triggerEvent(?:Checked)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // The call's argument list, to its matching close paren.
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
    }
    out.push(text.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

describe('worker:progress publishes', () => {
  const { Glob } = Bun;
  const offenders: string[] = [];
  let progressCalls = 0;
  for (const rel of new Glob('**/*.ts').scanSync(webSrc)) {
    if (rel.includes('.test.')) continue;
    const text = readFileSync(join(webSrc, rel), 'utf8');
    for (const args of callsIn(text)) {
      if (!/events\.WORKER_PROGRESS|'worker:progress'/.test(args)) continue;
      progressCalls++;
      if (/^\s*channels\.(worker|workspace)\(/.test(args)) offenders.push(`${rel}: ${args.split('\n')[0].trim()}`);
    }
  }

  it('found the publish sites it checks', () => {
    expect(progressCalls).toBeGreaterThan(10);
  });

  it('none goes to a worker or workspace channel', () => {
    expect(offenders).toEqual([]);
  });
});
