export interface Note {
  id: string;
  text: string;
  deletedAt?: number;
}

const notes = new Map<string, Note>();
const trash = new Map<string, Note>();

export function resetStore(): void {
  notes.clear();
  trash.clear();
}
export function put(n: Note): void {
  notes.set(n.id, n);
}
export function find(id: string): Note | undefined {
  return notes.get(id) ?? trash.get(id);
}
export function all(): Note[] {
  return [...notes.values()];
}
export function size(): number {
  return notes.size;
}
export function drop(id: string): boolean {
  const n = notes.get(id);
  if (!n) return false;
  notes.delete(id);
  trash.set(id, { ...n, deletedAt: Date.now() });
  return true;
}
export function undrop(id: string): boolean {
  const n = trash.get(id);
  if (!n) return false;
  trash.delete(id);
  const { deletedAt, ...rest } = n;
  notes.set(id, rest);
  return true;
}
