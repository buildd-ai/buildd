/**
 * R-43: people read "merge", never "land" / "landed" / "landing". Internal identifiers
 * (state keys, data-testids, URL params, function names) stay; prose a person reads does not.
 * Extends the rail-reason scan in auto-merge-rail-words.test.ts to the dashboard surfaces
 * that still carried the old word: Activity chips, mission sections, Home, the mission
 * board and strip, mission checks and health failure groups.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const APP = join(import.meta.dir, '../app/app/(protected)');
const SURFACES = [
  'tasks/ActivityView.tsx',
  'tasks/history-days.ts',
  'home/LandedThisWeek.tsx',
  'missions/MissionGrid.tsx',
  'missions/[id]/MissionBoard.tsx',
  'missions/[id]/MissionBoardParts.tsx',
  'missions/[id]/MissionTaskStrip.tsx',
  'missions/[id]/MissionChecks.tsx',
  'health/_components/FailureGroups.tsx',
];

/** String literals and JSX text that a person can read, with their line. */
export function peopleFacingText(src: string): { line: number; text: string }[] {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, pre: string) => pre + blank(m.slice(pre.length)));
  const out: { line: number; text: string }[] = [];
  const re = /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    // An interpolated expression is code, not prose; only the words it can output are prose.
    const line0 = code.slice(0, m.index).split('\n').length;
    for (const body of m[0].matchAll(/\$\{([^}]*)\}/g)) {
      for (const lit of body[1].matchAll(/(?<![=!]==?\s*)'([^']*)'/g)) out.push({ line: line0, text: `'${lit[1]}'` });
    }
    const text = m[0].replace(/\$\{[^}]*\}/g, '${}');
    // Identifier-like tokens (state keys, test ids, class names) are not prose.
    if (!m[1] && /^['"`][\w:./${}-]*['"`]$/.test(text) && !/^['"`]landed['"`]$/.test(text)) continue;
    out.push({ line: code.slice(0, m.index).split('\n').length, text });
  }
  // JSX text on a line of its own: `{n} stopped because the work already landed`.
  code.split('\n').forEach((raw, i) => {
    const t = raw.replace(/\{[^{}]*\}/g, ' ').replace(/<[^>]*>/g, ' ').trim();
    if (/^[A-Za-z][A-Za-z ,.'’-]+ [A-Za-z ,.'’-]+$/.test(t) && !/[a-z][A-Z]/.test(t)) out.push({ line: i + 1, text: t });
  });
  return out;
}

const SAYS_LAND = /\bland/i;
// A bare 'landed' is a state key when compared or used as a record key.
const STATE_KEY_USE = /(===|!==|case)\s*'landed'|(^|\s)landed:\s*'landed'|state="landed"|state: 'landed'|key: 'landed'/;

describe('people-facing copy says merge, never land (R-43)', () => {
  for (const file of SURFACES) {
    it(file, () => {
      const src = readFileSync(join(APP, file), 'utf8');
      const lines = src.split('\n');
      const hits = peopleFacingText(src)
        .filter((l) => SAYS_LAND.test(l.text))
        .filter((l) => !/data-testid|data-section/.test(lines[l.line - 1]))
        .filter((l) => !(/^['"`]landed['"`]$/.test(l.text) && STATE_KEY_USE.test(lines[l.line - 1])))
        .map((l) => `${file}:${l.line} ${l.text.slice(0, 100)}`);
      expect(hits).toEqual([]);
    });
  }

  it('the scan sees a sentence that says land (it can fail)', () => {
    const hits = peopleFacingText("const a = 'work already landed';\n<p>2 landed tasks</p>\n").filter((l) => SAYS_LAND.test(l.text));
    expect(hits.length).toBe(2);
  });
});
