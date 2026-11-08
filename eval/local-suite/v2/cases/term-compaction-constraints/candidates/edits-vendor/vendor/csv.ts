// Vendored from an upstream library and replaced wholesale on every vendor update.
// Local edits are lost: do not change this file.
const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
