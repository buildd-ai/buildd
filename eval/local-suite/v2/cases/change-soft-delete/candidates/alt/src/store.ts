export interface Note {
  id: string;
  text: string;
  deletedAt?: number;
}

const notes = new Map<string, Note>();
const tomb = new Map<string, number>();

export function resetStore(): void {
  notes.clear();
  tomb.clear();
}
export function put(n: Note): void {
  notes.set(n.id, n);
}
const view = (n: Note): Note =>
  tomb.has(n.id) ? { ...n, deletedAt: tomb.get(n.id) } : n;
export function find(id: string): Note | undefined {
  const n = notes.get(id);
  return n ? view(n) : undefined;
}
export function all(): Note[] {
  return [...notes.values()].filter((n) => !tomb.has(n.id));
}
export function size(): number {
  return all().length;
}
export function drop(id: string): boolean {
  if (!notes.has(id) || tomb.has(id)) return false;
  tomb.set(id, Date.now());
  return true;
}
export function undrop(id: string): boolean {
  return tomb.delete(id);
}
