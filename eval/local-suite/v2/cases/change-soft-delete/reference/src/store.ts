export interface Note {
  id: string;
  text: string;
  deletedAt?: number;
}

const notes = new Map<string, Note>();

export function resetStore(): void {
  notes.clear();
}
export function put(n: Note): void {
  notes.set(n.id, n);
}
/** Raw lookup: includes deleted notes. */
export function find(id: string): Note | undefined {
  return notes.get(id);
}
export function all(): Note[] {
  return [...notes.values()].filter((n) => n.deletedAt === undefined);
}
export function size(): number {
  return all().length;
}
export function drop(id: string): boolean {
  const n = notes.get(id);
  if (!n || n.deletedAt !== undefined) return false;
  n.deletedAt = Date.now();
  return true;
}
export function undrop(id: string): boolean {
  const n = notes.get(id);
  if (!n || n.deletedAt === undefined) return false;
  delete n.deletedAt;
  return true;
}
