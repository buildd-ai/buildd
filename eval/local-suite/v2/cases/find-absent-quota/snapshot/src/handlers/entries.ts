const entries: { id: number; memo: string }[] = [];

export const listEntries = () => entries.slice();

export function addEntry(b: { memo: string }) {
  const e = { id: entries.length + 1, memo: b.memo };
  entries.push(e);
  return e;
}
