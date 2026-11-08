export interface Note {
  id: string;
  text: string;
  deletedAt?: number;
}

// Same layout as a filtering store, but deleting an already-deleted note
// re-stamps it and reports success instead of refusing.
const notes = new Map<string, Note>();
const live = (n: Note | undefined): n is Note => !!n && n.deletedAt === undefined;

export function resetStore(): void {
  notes.clear();
}
export function put(n: Note): void {
  notes.set(n.id, n);
}
export function find(id: string): Note | undefined {
  const n = notes.get(id);
  return live(n) ? n : undefined;
}
export function all(): Note[] {
  return [...notes.values()].filter(live);
}
export function size(): number {
  return all().length;
}
export function drop(id: string): boolean {
  const n = notes.get(id);
  if (!n) return false;
  n.deletedAt = Date.now();
  return true;
}
export function undrop(id: string): boolean {
  const n = notes.get(id);
  if (!n || n.deletedAt === undefined) return false;
  delete n.deletedAt;
  return true;
}
