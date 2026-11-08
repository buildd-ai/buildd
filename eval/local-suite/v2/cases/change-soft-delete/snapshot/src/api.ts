import { createNote, deleteNote, getNote, listNotes } from './service';

export interface Res {
  status: number;
  body?: unknown;
}

export function handle(method: string, path: string, body?: any): Res {
  if (method === 'GET' && path === '/notes') {
    return { status: 200, body: listNotes() };
  }
  if (method === 'POST' && path === '/notes') {
    return { status: 201, body: createNote(body.id, body.text) };
  }
  const m = path.match(/^\/notes\/([^/]+)$/);
  if (m && method === 'GET') {
    const n = getNote(m[1]);
    return n ? { status: 200, body: n } : { status: 404 };
  }
  if (m && method === 'DELETE') {
    return { status: deleteNote(m[1]) ? 204 : 404 };
  }
  return { status: 404 };
}
