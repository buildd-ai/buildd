import { all, size } from './store';

export function noteCount(): number {
  return size();
}

export function latestNoteId(): string | null {
  return all().at(-1)?.id ?? null;
}
