/**
 * Is an edited acceptance test still as strict as it was (Living Specs R-80)?
 *
 * Pure and deterministic: old source in, new source out, a verdict. `stricter`
 * and `equivalent` let the edit through without a person; `loosened` and
 * `unparseable` do not. Only claims what it can show: anything it cannot tell
 * apart from a weaker check is reported as weaker.
 *
 * No TypeScript parser (this package has no runtime dependencies): a small
 * scanner masks comments, strings and regexes, then finds `it`/`test` calls
 * and the `expect(..).matcher(..)` / `assert(..)` statements inside them.
 */

export type StrictnessVerdict = 'stricter' | 'equivalent' | 'loosened' | 'unparseable';
export type WeakenedKind = 'removed' | 'matcher' | 'widened' | 'changed' | 'test_dropped' | 'skipped' | 'file_removed' | 'setup';

export interface Weakened {
  kind: WeakenedKind;
  /** Short plain sentence naming what got weaker. */
  text: string;
}

export interface StrictnessResult {
  verdict: StrictnessVerdict;
  /** What got weaker; empty unless `loosened`. */
  weakened: Weakened[];
  /** What got stricter, for the evidence record. */
  stricter: string[];
  /** Why it could not be read; only on `unparseable`. */
  reason?: string;
}

interface Assertion { subject: string; mods: string; matcher: string; args: string; key: string; start: number; end: number }
interface TestCase { name: string; skipped: boolean; only: boolean; assertions: Assertion[] }
interface Parsed { tests: Map<string, TestCase>; skippedGroups: number; residue: string[] }

class Unreadable extends Error {}

/** Same-length copy of `src`: comments become spaces, string/regex/template text becomes `_`. */
function maskSource(src: string): string {
  const n = src.length;
  const out = src.split('');
  const blank = (a: number, b: number, ch: string) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ch; };
  const fail = (why: string): never => { throw new Unreadable(why); };
  function template(start: number): number {
    let i = start;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { blank(i, i + 2, '_'); i += 2; continue; }
      if (c === '`') return i + 1;
      if (c === '$' && src[i + 1] === '{') { i = code(i + 2, true); continue; }
      blank(i, i + 1, '_'); i++;
    }
    return fail('unterminated template');
  }
  function code(start: number, inExpr: boolean): number {
    let i = start, depth = 0, prev = '';
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end, ' '); i = end; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) fail('unterminated comment'); blank(i, e + 2, ' '); i = e + 2; continue; }
      if (c === '\'' || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') fail('unterminated string'); j++; }
        if (j >= n) fail('unterminated string');
        blank(i + 1, j, '_'); i = j + 1; prev = c; continue;
      }
      if (c === '`') { i = template(i + 1); prev = '`'; continue; }
      if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) {
        let j = i + 1, inClass = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '\n') fail('unterminated regex');
          if (ch === '[') inClass = true; else if (ch === ']') inClass = false; else if (ch === '/' && !inClass) break;
          j++;
        }
        if (j >= n) fail('unterminated regex');
        blank(i + 1, j, '_'); i = j + 1;
        while (i < n && /[a-z]/.test(src[i]!)) i++;
        prev = ')'; continue;
      }
      if (c === '{') depth++;
      if (c === '}') { if (depth === 0 && inExpr) return i + 1; if (depth > 0) depth--; }
      if (!/\s/.test(c!)) prev = c!;
      i++;
    }
    if (inExpr) fail('unterminated template expression');
    return i;
  }
  code(0, false);
  const mask = out.join('');
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const c of mask) {
    if ('([{'.includes(c)) stack.push(c);
    else if (c in pairs && stack.pop() !== pairs[c]) fail('unbalanced brackets');
  }
  if (stack.length) fail('unbalanced brackets');
  return mask;
}

function closeOf(mask: string, open: number): number {
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    const c = mask[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i;
  }
  throw new Unreadable('unbalanced brackets');
}

const normQuotes = (s: string) => s.replace(/,(?=[)\]}])/g, '').replace(/'([^'"\\\n`]*)'/g, '"$1"');

function parse(src: string): Parsed {
  const mask = maskSource(src);
  const norm = (a: number, b: number) => {
    let s = '';
    for (let k = a; k < b; k++) if (!/\s/.test(mask[k]!)) s += src[k];
    return normQuotes(s);
  };
  const tests = new Map<string, TestCase>();
  const seen = new Map<string, number>();
  const cuts: Array<[number, number]> = [];
  const bodies: Array<{ test: TestCase; from: number; to: number }> = [];
  let skippedGroups = 0;

  const call = /(?<![\w$.])(xit|xtest|xdescribe|it|test|describe)((?:\.[A-Za-z]+)*)\s*\(/g;
  for (let m = call.exec(mask); m; m = call.exec(mask)) {
    const mods = m[2]!.split('.').filter(Boolean);
    const open = m.index + m[0].length - 1;
    if (m[1] === 'describe' || m[1] === 'xdescribe') {
      if (m[1] === 'xdescribe' || mods.includes('skip') || mods.includes('todo')) skippedGroups++;
      continue;
    }
    if (mods.includes('each') || mods.includes('for')) throw new Unreadable('table-driven tests');
    const close = closeOf(mask, open);
    let k = open + 1;
    while (/\s/.test(mask[k]!)) k++;
    const q = mask[k];
    if (q !== '\'' && q !== '"' && q !== '`') throw new Unreadable('a test name is not plain text');
    const j = mask.indexOf(q, k + 1);
    if (j < 0 || j > close || (q === '`' && src.slice(k, j).includes('${'))) throw new Unreadable('a test name is not plain text');
    const base = src.slice(k + 1, j);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    // Body: the first `{` at call depth 1 that follows `=>` or `)`; else an expression body after `=>`.
    let depth = 0, bodyOpen = -1;
    for (let i = open; i <= close; i++) {
      const c = mask[i]!;
      if (c === '{' && depth === 1 && i > j) {
        let p = i - 1;
        while (/\s/.test(mask[p]!)) p--;
        if (mask[p] === '>' || mask[p] === ')') { bodyOpen = i; break; }
      }
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    }
    let from: number, to: number, headEnd: number;
    if (bodyOpen >= 0) { from = bodyOpen + 1; to = closeOf(mask, bodyOpen); headEnd = bodyOpen + 1; }
    else {
      const arrow = mask.indexOf('=>', j);
      if (arrow < 0 || arrow > close) throw new Unreadable('a test has no readable body');
      from = arrow + 2; to = close; headEnd = from;
    }
    const tc: TestCase = {
      name: nth > 1 ? `${base} (#${nth})` : base,
      skipped: m[1]!.startsWith('x') || mods.includes('skip') || mods.includes('todo'),
      only: mods.includes('only'),
      assertions: [],
    };
    tests.set(tc.name, tc);
    cuts.push([m.index, headEnd]);
    bodies.push({ test: tc, from, to });
  }

  const found: Assertion[] = [];
  const expectRe = /(?<![\w$.])expect\s*\(/g;
  for (let m = expectRe.exec(mask); m; m = expectRe.exec(mask)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(mask, open);
    const subject = norm(open + 1, close);
    const mods: string[] = [];
    let pos = close + 1;
    for (;;) {
      let p = pos;
      while (/\s/.test(mask[p] ?? 'x')) p++;
      if (mask[p] !== '.') break;
      p++;
      while (/\s/.test(mask[p] ?? 'x')) p++;
      const id = /^[A-Za-z_$][\w$]*/.exec(mask.slice(p))?.[0];
      if (!id) break;
      p += id.length;
      if (id === 'not' || id === 'resolves' || id === 'rejects') { mods.push(id); pos = p; continue; }
      let a = p;
      while (/\s/.test(mask[a] ?? 'x')) a++;
      if (mask[a] !== '(') break;
      const aEnd = closeOf(mask, a);
      const args = norm(a + 1, aEnd);
      found.push({ subject, mods: mods.join('.'), matcher: id, args, key: `${subject}|${mods.join('.')}|${id}|${args}`, start: m.index, end: aEnd + 1 });
      break;
    }
  }
  const assertRe = /(?<![\w$.])assert(\.[A-Za-z]+)?\s*\(/g;
  for (let m = assertRe.exec(mask); m; m = assertRe.exec(mask)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(mask, open);
    const args = norm(open + 1, close);
    const matcher = `assert${m[1] ?? ''}`;
    found.push({ subject: '', mods: '', matcher, args, key: `|${matcher}|${args}`, start: m.index, end: close + 1 });
  }
  for (const a of found) {
    const body = bodies.find((b) => a.start >= b.from && a.end <= b.to);
    if (body) { body.test.assertions.push(a); cuts.push([a.start, a.end]); }
  }

  // What is left once tests' headers and assertions are cut: setup and helpers, as statement chunks.
  const dead = new Uint8Array(src.length);
  for (const [a, b] of cuts) dead.fill(1, a, b);
  let flat = '';
  for (let k = 0; k < src.length; k++) {
    if (dead[k]) continue;
    const mc = mask[k]!;
    if (mc === ';' || mc === '{' || mc === '}') flat += '\u0000';
    else if (!/\s/.test(mc)) flat += src[k];
  }
  const residue = flat.split('\u0000').map(normQuotes).filter((c) => /[\w$]/.test(c) && !c.startsWith('import'));
  return { tests, skippedGroups, residue };
}

const RANK: Record<string, number> = {
  toBe: 4, toStrictEqual: 4, toBeNull: 4, toBeUndefined: 4, toBeNaN: 4, toHaveLength: 4, toHaveBeenCalledTimes: 4,
  toEqual: 3, toBeCloseTo: 3,
  toMatchObject: 2, toContain: 2, toContainEqual: 2, toHaveProperty: 2, toMatch: 2, toHaveBeenCalledWith: 2, toHaveBeenCalled: 2, toThrow: 2, toBeInstanceOf: 2,
  toBeTruthy: 1, toBeFalsy: 1, toBeDefined: 1, toBeGreaterThan: 1, toBeGreaterThanOrEqual: 1, toBeLessThan: 1, toBeLessThanOrEqual: 1,
};
const LABEL = (r: number) => (r >= 4 ? 'exact' : r === 3 ? 'close' : r === 2 ? 'partial' : 'loose');

const num = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));
const splitArgs = (s: string) => {
  const parts: string[] = []; let depth = 0, cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  return [...parts, cur];
};
const strLit = (s: string) => /^"([^"\\]*)"$/.exec(s)?.[1] ?? null;
const reLit = (s: string) => { const m = /^\/(.*)\/([a-z]*)$/.exec(s); return m ? { src: m[1]!, flags: m[2]! } : null; };
const LOOSE_TOKENS = /[.*?|]|\\[wdsWDS]|\[\^/g;

type Move = 'stricter' | 'widened' | 'changed';

function regexMove(a: { src: string; flags: string }, b: { src: string; flags: string }): Move {
  if (b.flags.includes('i') && !a.flags.includes('i')) return 'widened';
  if (a.flags.includes('i') && !b.flags.includes('i')) return 'stricter';
  for (const anchor of ['^', '$']) {
    if (a.src.includes(anchor) && !b.src.includes(anchor)) return 'widened';
    if (!a.src.includes(anchor) && b.src.includes(anchor)) return 'stricter';
  }
  const count = (s: string) => (s.replace(/\\[^wdsWDS]/g, '').match(LOOSE_TOKENS) ?? []).length;
  if (count(b.src) !== count(a.src)) return count(b.src) > count(a.src) ? 'widened' : 'stricter';
  if (b.src.length !== a.src.length) return b.src.length < a.src.length ? 'widened' : 'stricter';
  return 'changed';
}

/** How the same matcher on the same subject moved when only its arguments differ. */
function argsMove(x: Assertion, y: Assertion): Move {
  if (x.subject !== y.subject || x.mods !== y.mods || x.mods.includes('not')) return 'changed';
  const [xa, ya] = [splitArgs(x.args), splitArgs(y.args)];
  const dir = (a: number | null, b: number | null, higherIsStricter: boolean): Move =>
    a === null || b === null || a === b ? 'changed' : (b > a) === higherIsStricter ? 'stricter' : 'widened';
  switch (x.matcher) {
    case 'toBeCloseTo':
      return xa[0] === ya[0] ? dir(num(xa[1] ?? '2'), num(ya[1] ?? '2'), true) : 'changed';
    case 'toBeGreaterThan': case 'toBeGreaterThanOrEqual': return dir(num(x.args), num(y.args), true);
    case 'toBeLessThan': case 'toBeLessThanOrEqual': return dir(num(x.args), num(y.args), false);
    case 'toMatch': case 'toContain': {
      const [ra, rb] = [reLit(x.args), reLit(y.args)];
      if (ra && rb && x.matcher === 'toMatch') return regexMove(ra, rb);
      const [sa, sb] = [strLit(x.args), strLit(y.args)];
      if (sa === null || sb === null || sa === sb) return 'changed';
      return sa.includes(sb) ? 'widened' : sb.includes(sa) ? 'stricter' : 'changed';
    }
    case 'toThrow':
      return x.args !== '' && y.args === '' ? 'widened' : x.args === '' && y.args !== '' ? 'stricter' : 'changed';
    default: return 'changed';
  }
}

const show = (a: Assertion) => `\`${(a.subject || a.args).slice(0, 40)}\``;

function classify(x: Assertion, y: Assertion): { move: Move | 'looser'; weak?: Weakened; note?: string } {
  const what = show(x);
  let move: Move | 'looser';
  let detail = '';
  if (x.mods !== y.mods) move = 'changed';
  else if (x.matcher !== y.matcher) {
    const [rx, ry] = [RANK[x.matcher], RANK[y.matcher]];
    if (rx === undefined || ry === undefined || rx === ry || x.mods.includes('not')) move = 'changed';
    else if (rx > ry) { move = 'looser'; detail = ` (was ${LABEL(rx)}, now ${LABEL(ry)})`; }
    else move = 'stricter';
  } else move = argsMove(x, y);
  if (move === 'stricter') return { move, note: `the check on ${what} got tighter` };
  if (move === 'looser') return { move, weak: { kind: 'matcher', text: `the check on ${what} got looser${detail}` } };
  if (move === 'widened') return { move, weak: { kind: 'widened', text: `the check on ${what} now accepts more` } };
  return { move, weak: { kind: 'changed', text: `the check on ${what} was changed, so it may accept more` } };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function compareTest(name: string, before: Assertion[], after: Assertion[]): { weak: Weakened[]; stricter: string[] } {
  const weak: Weakened[] = [], stricter: string[] = [];
  const pool = [...after];
  const left: Assertion[] = [];
  for (const x of before) {
    const i = pool.findIndex((y) => y.key === x.key);
    if (i >= 0) pool.splice(i, 1); else left.push(x);
  }
  const prefix = `In "${name}": `;
  for (const x of left) {
    let i = pool.findIndex((y) => y.subject === x.subject && y.mods === x.mods && y.matcher === x.matcher);
    if (i < 0) i = pool.findIndex((y) => y.subject === x.subject);
    if (i < 0) i = pool.findIndex((y) => y.matcher === x.matcher && x.subject !== '');
    if (i < 0) { weak.push({ kind: 'removed', text: cap(`${prefix}a check on ${show(x)} was removed`) }); continue; }
    const [y] = pool.splice(i, 1);
    const c = classify(x, y!);
    if (c.weak) weak.push({ kind: c.weak.kind, text: `${prefix}${c.weak.text}` });
    if (c.note) stricter.push(`${prefix}${c.note}`);
  }
  for (const y of pool) stricter.push(`${prefix}a check on ${show(y)} was added`);
  return { weak, stricter };
}

const ADDED_SETUP = /mock\.module|vi\.mock|jest\.mock|beforeEach|beforeAll|\.skip\b/;

export function compareAcceptanceStrictness(before: string | null, after: string | null): StrictnessResult {
  const unreadable = (reason: string): StrictnessResult => ({ verdict: 'unparseable', weakened: [], stricter: [], reason });
  let old: Parsed | null = null, now: Parsed | null = null;
  try {
    old = before === null ? null : parse(before);
    now = after === null ? null : parse(after);
  } catch (e) {
    if (e instanceof Unreadable) return unreadable(e.message);
    throw e;
  }
  if (old && !old.tests.size) return unreadable('no tests found in the earlier version');
  if (now && !now.tests.size) return unreadable('no tests found in the new version');
  if (!old) return { verdict: now ? 'stricter' : 'equivalent', weakened: [], stricter: ['a new test file'] };
  if (!now) return { verdict: 'loosened', weakened: [{ kind: 'file_removed', text: 'The whole test file was deleted' }], stricter: [] };

  const weakened: Weakened[] = [], stricter: string[] = [];
  for (const [name, o] of old.tests) {
    const n = now.tests.get(name);
    if (!n) { weakened.push({ kind: 'test_dropped', text: `The test "${name}" was removed` }); continue; }
    if (n.skipped && !o.skipped) { weakened.push({ kind: 'skipped', text: `The test "${name}" is now skipped` }); continue; }
    const r = compareTest(name, o.assertions, n.assertions);
    weakened.push(...r.weak); stricter.push(...r.stricter);
  }
  for (const [name, n] of now.tests) {
    if (!old.tests.has(name)) stricter.push(`the test "${name}" was added`);
    else if (n.only && !old.tests.get(name)!.only) weakened.push({ kind: 'skipped', text: 'Other tests no longer run (a test was marked as the only one)' });
  }
  if (now.skippedGroups > old.skippedGroups) weakened.push({ kind: 'skipped', text: 'A group of tests is now skipped' });

  const left = [...now.residue];
  const removed = old.residue.filter((c) => { const i = left.indexOf(c); if (i >= 0) { left.splice(i, 1); return false; } return true; });
  if (removed.length || left.some((c) => ADDED_SETUP.test(c))) {
    weakened.push({ kind: 'setup', text: "Code around the tests changed, so a weaker check can't be ruled out" });
  }

  if (weakened.length) return { verdict: 'loosened', weakened, stricter };
  return { verdict: stricter.length ? 'stricter' : 'equivalent', weakened: [], stricter };
}
