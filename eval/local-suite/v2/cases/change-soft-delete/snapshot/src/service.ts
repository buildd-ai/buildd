import { all, drop, find, put, type Note } from './store';

export function createNote(id: string, text: string): Note {
  const n = { id, text };
  put(n);
  return n;
}

export function getNote(id: string): Note | null {
  return find(id) ?? null;
}

export function listNotes(): Note[] {
  return all();
}

export function deleteNote(id: string): boolean {
  return drop(id);
}
