export interface Note {
  id: string;
  text: string;
  deletedAt?: number;
}

// Hard-deletes the record and keeps a side copy so restore can bring it back;
// list order comes from creation order. Nothing is ever marked with deletedAt.
const notes = new Map<string, Note>();
const removed = new Map<string, Note>();
const order: string[] = [];

export function resetStore(): void {
  notes.clear();
  removed.clear();
  order.length = 0;
}
export function put(n: Note): void {
  if (!notes.has(n.id) && !removed.has(n.id)) order.push(n.id);
  notes.set(n.id, n);
}
export function find(id: string): Note | undefined {
  return notes.get(id);
}
export function all(): Note[] {
  return order.filter((id) => notes.has(id)).map((id) => notes.get(id)!);
}
export function size(): number {
  return notes.size;
}
export function drop(id: string): boolean {
  const n = notes.get(id);
  if (!n) return false;
  notes.delete(id);
  removed.set(id, n);
  return true;
}
export function undrop(id: string): boolean {
  const n = removed.get(id);
  if (!n) return false;
  removed.delete(id);
  notes.set(id, n);
  return true;
}
