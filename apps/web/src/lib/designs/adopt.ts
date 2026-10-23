import { extractScreens, type DesignScreen } from './screens';

/**
 * Adopting a file that is already in buildd as a design: an HTML export that
 * was uploaded as a plain file artifact (no `metadata.kind`) before designs had
 * their own path. Its screens are read from its markers, as a new export's are,
 * and nothing else about the file changes. Pure; the service reads the file.
 */
export function isAdoptableFile(a: { storageKey: string | null; metadata: Record<string, unknown> | null }): boolean {
  if (!a.storageKey || !a.metadata) return false;
  const mime = typeof a.metadata.mimeType === 'string' ? a.metadata.mimeType.split(';')[0].trim().toLowerCase() : '';
  const name = typeof a.metadata.filename === 'string' ? a.metadata.filename.toLowerCase() : '';
  return mime === 'text/html' || /\.html?$/.test(name);
}

export type AdoptionPlan = { ok: true; screens: DesignScreen[] } | { ok: false; field: string; message: string };

export function planAdoption(html: string): AdoptionPlan {
  return extractScreens(html);
}
