export interface Note {
  id: string;
  text: string;
  deletedAt?: number;
}

// Records are never mutated in place: delete and restore replace the stored
// record with a copy. Map.set on an existing key keeps its position.
const notes = new Map<string, Note>();

export function resetStore(): void {
  notes.clear();
}
export function put(n: Note): void {
  notes.set(n.id, n);
}
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
  notes.set(id, { ...n, deletedAt: Date.now() });
  return true;
}
export function undrop(id: string): boolean {
  const n = notes.get(id);
  if (!n || n.deletedAt === undefined) return false;
  const { deletedAt: _, ...rest } = n;
  notes.set(id, rest);
  return true;
}
