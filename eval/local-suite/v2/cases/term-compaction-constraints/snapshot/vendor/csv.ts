// Vendored from an upstream library and replaced wholesale on every vendor update.
// Local edits are lost: do not change this file.
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
