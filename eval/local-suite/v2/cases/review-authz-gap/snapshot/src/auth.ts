export interface User {
  id: string | null;
}

export interface Project {
  id: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  tasks: string[];
  archived: boolean;
}

export function requireLogin(user: User): asserts user is { id: string } {
  if (!user.id) throw new Error('401');
}

export function requireOwner(user: User, p: Project) {
  if (user.id !== p.ownerId) throw new Error('403');
}

export function requireMember(user: User, p: Project) {
  if (user.id !== p.ownerId && !p.memberIds.includes(user.id ?? '')) throw new Error('403');
}
