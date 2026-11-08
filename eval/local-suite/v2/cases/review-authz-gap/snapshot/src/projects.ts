import { type User, requireLogin, requireMember, requireOwner } from './auth';
import { db } from './db';

export function getProject(user: User, id: string) {
  requireLogin(user);
  return db.projects.get(id) ?? null;
}

export function renameProject(user: User, id: string, name: string) {
  requireLogin(user);
  const p = db.projects.get(id);
  if (!p) return null;
  requireOwner(user, p);
  p.name = name;
  return p;
}

export function archiveProject(user: User, id: string) {
  requireLogin(user);
  const p = db.projects.get(id);
  if (!p) return false;
  requireOwner(user, p);
  p.archived = true;
  return true;
}

export function deleteProject(user: User, id: string) {
  requireLogin(user);
  return db.projects.delete(id);
}

/** Members may export; the export contains only data they can already read. */
export function exportProject(user: User, id: string) {
  requireLogin(user);
  const p = db.projects.get(id);
  if (!p) return null;
  requireMember(user, p);
  return JSON.stringify({ name: p.name, tasks: p.tasks });
}
