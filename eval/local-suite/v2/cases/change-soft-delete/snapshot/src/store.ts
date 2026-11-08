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
export function find(id: string): Note | undefined {
  return notes.get(id);
}
export function all(): Note[] {
  return [...notes.values()];
}
export function size(): number {
  return notes.size;
}
export function drop(id: string): boolean {
  return notes.delete(id);
}
