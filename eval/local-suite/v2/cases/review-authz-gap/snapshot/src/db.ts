import type { Project } from './auth';

export const db = { projects: new Map<string, Project>() };
