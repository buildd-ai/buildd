import { beforeEach, expect, test } from 'bun:test';
import { db } from '../src/db';
import { archiveProject, deleteProject, exportProject } from '../src/projects';

beforeEach(() => {
  db.projects.clear();
  db.projects.set('p1', { id: 'p1', name: 'Plan', ownerId: 'u1', memberIds: ['u2'], tasks: ['a'], archived: false });
});

test('the owner can archive and delete', () => {
  expect(archiveProject({ id: 'u1' }, 'p1')).toBe(true);
  expect(deleteProject({ id: 'u1' }, 'p1')).toBe(true);
});

test('a member can export, a stranger cannot', () => {
  expect(exportProject({ id: 'u2' }, 'p1')).toContain('Plan');
  expect(() => exportProject({ id: 'u9' }, 'p1')).toThrow('403');
});
