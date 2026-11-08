const dir = process.env.CANDIDATE_DIR!;
const { sanitizePayload } = await import(`${dir}/src/sanitize.ts`);

const bad: string[] = [];
const eq = (name: string, got: unknown, want: unknown) => {
  if (got !== want) bad.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo, d, h, mi, 0);
const s = (v: string, t: number) => sanitizePayload({ v }, t).v;

const midnight = at(2026, 9, 11);
eq('date-only, start of day', s('2026-10-11', midnight), '2000-01-01');
eq('date-only, +2 days', s('2026-10-13', midnight), '2000-01-03');

const late = at(2026, 9, 11, 23, 30);
eq('date-only, creation day late in the day', s('2026-10-11', late), '2000-01-01');
eq('date-only, next day late in the day', s('2026-10-12', late), '2000-01-02');
eq('date-only, +10 days late in the day', s('2026-10-21', late), '2000-01-11');

eq('zone-less', s('2026-10-11T12:30:00', midnight), '2000-01-01T12:30:00');
eq('zone-less, space separator', s('2026-10-11 12:30:00', midnight), '2000-01-01 12:30:00');
eq('utc timestamp', s('2026-10-11T12:30:00Z', midnight), '2000-01-01T12:30:00Z');
eq('offset timestamp', s('2026-10-11T14:30:00+02:00', midnight), '2000-01-01T12:30:00+00:00');

const mixed = sanitizePayload({ n: ['due 2026-10-12 and 2026-10-11T08:00:00Z', 7] }, late);
if (!String(mixed.n[0]).startsWith('due 2000-01-02 and ')) bad.push('embedded date-only not shifted: ' + mixed.n[0]);
if (/2026/.test(JSON.stringify(mixed))) bad.push('an original year survives in embedded text');
eq('non-string left alone', mixed.n[1], 7);
eq('plain text untouched', s('release 1.2.3 shipped', midnight), 'release 1.2.3 shipped');

if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log('ok');
