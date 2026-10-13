import { describe, it, expect } from 'bun:test';
import ts from 'typescript';
import { applyEdits, convertDrizzleInit, convertRelations, transformCallSites } from './rqb-v2';

// The codemod runs once, at the drizzle v1 bump. These pin what it writes, on
// small in-memory sources, so the cutover runs a tested transform. Whether the
// output is correct drizzle v1 is checked separately: the helpers it calls are
// tested on both versions (packages/core/__tests__/relational-sql.test.ts).

const ROOT = '/repo';

function program(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, types: [] };
  const host = ts.createCompilerHost(options);
  const abs = (f: string) => (f.startsWith('/') ? f : `${ROOT}/${f}`);
  const virtual = new Map(Object.entries(files).map(([f, text]) => [abs(f), text]));
  host.fileExists = (f) => virtual.has(f) || ts.sys.fileExists(f);
  host.readFile = (f) => virtual.get(f) ?? ts.sys.readFile(f);
  host.directoryExists = (d) => [...virtual.keys()].some((f) => f.startsWith(`${d}/`)) || ts.sys.directoryExists(d);
  host.realpath = (f) => f;
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang, onError, create) =>
    virtual.has(f) ? ts.createSourceFile(f, virtual.get(f)!, lang, true) : getSourceFile(f, lang, onError, create);
  return ts.createProgram({ rootNames: [...virtual.keys()], options, host });
}

// Stand-ins for drizzle: only whether something is callable matters to the codemod.
const PRELUDE = `
type SQL = { readonly __sql: true };
declare const db: any;
declare const tasks: any;
declare const workers: any;
declare function eq(a: unknown, b: unknown): SQL;
declare function and(...a: (SQL | undefined)[]): SQL | undefined;
declare function desc(a: unknown): SQL;
declare const sql: any;
`;

function run(files: Record<string, string>) {
  const prog = program(files);
  const res = transformCallSites(prog, Object.keys(files).map((f) => `${ROOT}/${f}`), ROOT);
  const out = (f: string) => res.files.get(`${ROOT}/${f}`);
  return { ...res, out };
}

describe('transformCallSites', () => {
  it('wraps SQL filters and orderings, and adds the helper import after the last import', () => {
    const { out, errors } = run({
      'apps/web/src/a.ts': `import { x } from './x';
${PRELUDE}
export const q = (id: string) => db.query.tasks.findFirst({ where: eq(tasks.id, id), orderBy: [desc(tasks.createdAt)], columns: { id: true } });
`,
      'apps/web/src/x.ts': 'export const x = 1;\n',
    });
    expect(errors).toEqual([]);
    expect(out('apps/web/src/a.ts')).toBe(`import { x } from './x';
import { sqlOrderBy, sqlWhere } from '@buildd/core/db/relational-sql';
${PRELUDE}
export const q = (id: string) => db.query.tasks.findFirst({ where: sqlWhere(eq(tasks.id, id)), orderBy: sqlOrderBy([desc(tasks.createdAt)]), columns: { id: true } });
`);
  });

  it('wraps callbacks in sqlWhereFn / sqlOrderByFn, inline or by reference', () => {
    const { out } = run({
      'apps/web/src/a.ts': `${PRELUDE}
const byNewest = (t: any, o: any) => [o.desc(t.createdAt)];
export const q = () => db.query.tasks.findMany({ where: (t: any, { eq }: any) => eq(t.id, 1), orderBy: byNewest });
`,
    });
    expect(out('apps/web/src/a.ts')).toContain(
      `db.query.tasks.findMany({ where: { RAW: sqlWhereFn((t: any, { eq }: any) => eq(t.id, 1)) }, orderBy: sqlOrderByFn(byNewest) });`,
    );
    expect(out('apps/web/src/a.ts')).toContain(`import { sqlOrderByFn, sqlWhereFn } from '@buildd/core/db/relational-sql';`);
  });

  it('rewrites shorthand where / orderBy and leaves where: undefined alone', () => {
    const { out } = run({
      'apps/web/src/a.ts': `${PRELUDE}
export const q = (where: SQL | undefined, orderBy: SQL) => [
  db.query.tasks.findMany({ where, orderBy }),
  db.query.tasks.findMany({ where: undefined, limit: 1 }),
];
`,
    });
    expect(out('apps/web/src/a.ts')).toContain('db.query.tasks.findMany({ where: sqlWhere(where), orderBy: sqlOrderBy(orderBy) }),');
    expect(out('apps/web/src/a.ts')).toContain('db.query.tasks.findMany({ where: undefined, limit: 1 }),');
  });

  it('recurses into nested with configs, spreads and conditionals', () => {
    const { out, errors } = run({
      'apps/web/src/a.ts': `${PRELUDE}
export const q = (id: string, n?: number) => db.query.tasks.findMany({
  ...(n ? { orderBy: desc(tasks.id), limit: n } : {}),
  with: {
    workspace: true,
    workers: { where: eq(workers.status, 'running'), orderBy: desc(workers.startedAt), limit: 1, with: { account: { where: eq(workers.id, id) } } },
  },
});
`,
    });
    expect(errors).toEqual([]);
    const text = out('apps/web/src/a.ts')!;
    expect(text).toContain('...(n ? { orderBy: sqlOrderBy(desc(tasks.id)), limit: n } : {}),');
    expect(text).toContain(
      "workers: { where: sqlWhere(eq(workers.status, 'running')), orderBy: sqlOrderBy(desc(workers.startedAt)), limit: 1, with: { account: { where: sqlWhere(eq(workers.id, id)) } } },",
    );
    expect(text).toContain('workspace: true,');
  });

  it('follows a with map and a config builder into another file, once each', () => {
    const { out, errors } = run({
      'apps/web/src/shared.ts': `${PRELUDE}
export const SHARED_WITH = {
  workers: { orderBy: [desc(workers.startedAt)], limit: 5 },
} as const;
export function buildArgs(where: SQL | undefined) {
  return { where: and(where, eq(tasks.status, 'open')), with: SHARED_WITH };
}
`,
      'apps/web/src/a.ts': `import { SHARED_WITH, buildArgs } from './shared';
${PRELUDE}
export const q = () => [db.query.tasks.findMany({ with: SHARED_WITH }), db.query.tasks.findMany(buildArgs(undefined) as any)];
export const r = () => db.query.tasks.findMany({ with: SHARED_WITH });
`,
    });
    expect(errors).toEqual([]);
    expect(out('apps/web/src/a.ts')).toBeUndefined();
    const shared = out('apps/web/src/shared.ts')!;
    expect(shared).toContain('workers: { orderBy: sqlOrderBy([desc(workers.startedAt)]), limit: 5 },');
    expect(shared).toContain("return { where: sqlWhere(and(where, eq(tasks.status, 'open'))), with: SHARED_WITH };");
    expect(shared.match(/sqlOrderBy\(/g)).toHaveLength(1);
  });

  it('turns an extras object into sqlExtras and splits an extras callback per key', () => {
    const { out, errors } = run({
      'apps/web/src/a.ts': `${PRELUDE}
const EXTRAS = (t: any, { sql }: any) => ({
  a: sql\`\${t.x}\`.as('a'),
  b: sql\`1\`.as('b'),
});
export const q = () => [
  db.query.tasks.findMany({ extras: { n: sql\`\${tasks.x} + 1\`.as('n') } }),
  db.query.tasks.findMany({ with: { workers: { extras: EXTRAS } } }),
];
`,
    });
    expect(errors).toEqual([]);
    const text = out('apps/web/src/a.ts')!;
    expect(text).toContain("extras: sqlExtras({ n: sql`${tasks.x} + 1`.as('n') })");
    expect(text).toContain(`const EXTRAS = {
  a: (t: any, { sql }: any) => sql\`\${t.x}\`.as('a'),
  b: (t: any, { sql }: any) => sql\`1\`.as('b'),
};`);
  });

  it('imports the helpers relatively inside packages/core and scripts', () => {
    const { out } = run({
      'packages/core/foo/bar.ts': `${PRELUDE}\nexport const q = () => db.query.tasks.findFirst({ where: eq(tasks.id, 1) });\n`,
      'scripts/tool.ts': `${PRELUDE}\nexport const q = () => db.query.tasks.findFirst({ where: eq(tasks.id, 1) });\n`,
    });
    expect(out('packages/core/foo/bar.ts')).toStartWith(`import { sqlWhere } from '../db/relational-sql';\n`);
    expect(out('scripts/tool.ts')).toStartWith(`import { sqlWhere } from '../packages/core/db/relational-sql';\n`);
  });

  it('leaves already-converted values alone, so a second run changes nothing', () => {
    const src = `${PRELUDE}
declare function sqlWhere(e: unknown): unknown;
declare function sqlOrderBy(e: unknown): unknown;
export const q = () => db.query.tasks.findMany({ where: sqlWhere(eq(tasks.id, 1)), orderBy: sqlOrderBy(desc(tasks.id)), with: { workers: { where: { RAW: (t: any) => eq(t.id, 1) } } } });
`;
    const { out, errors } = run({ 'apps/web/src/a.ts': src });
    expect(errors).toEqual([]);
    expect(out('apps/web/src/a.ts')).toBeUndefined();
  });

  it('matches a call chain split across lines', () => {
    const { out } = run({
      'apps/web/src/a.ts': `${PRELUDE}
export const q = () => db.query.tasks\n  .findMany({ where: eq(tasks.id, 1) });\n`,
    });
    expect(out('apps/web/src/a.ts')).toContain('.findMany({ where: sqlWhere(eq(tasks.id, 1)) });');
  });

  it('reports a fragment it cannot resolve instead of guessing', () => {
    const { errors } = run({
      'apps/web/src/a.ts': `${PRELUDE}\ndeclare const cfg: any;\nexport const q = () => db.query.tasks.findMany({ with: cfg.with });\n`,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('apps/web/src/a.ts:');
    expect(errors[0]).toContain('cannot resolve with fragment');
  });
});

const SCHEMA = `import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
});

export const posts = pgTable('posts', {
  id: uuid('id').primaryKey(),
  authorId: uuid('author_id').references(() => users.id).notNull(),
  editorId: uuid('editor_id').references(() => users.id),
  parentId: uuid('parent_id'),
  body: text('body').default(sql\`''\`),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts, { relationName: 'authored' }),
  edited: many(posts, { relationName: 'edited' }),
}));

// Posts thread under a parent.
export const postsRelations = relations(posts, ({ one, many }) => ({
  // Every post has an author.
  author: one(users, { fields: [posts.authorId], references: [users.id], relationName: 'authored' }),
  editor: one(users, { fields: [posts.editorId], references: [users.id], relationName: 'edited' }),
  parent: one(posts, { fields: [posts.parentId], references: [posts.id], relationName: 'thread' }),
  replies: many(posts, { relationName: 'thread' }),
}));

export type Post = typeof posts.$inferSelect;
`;

describe('convertRelations', () => {
  it('writes one defineRelations with from/to, optional: false for NOT NULL keys, and aliases', () => {
    const { relations, errors } = convertRelations(SCHEMA);
    expect(errors).toEqual([]);
    expect(relations).toContain(`export const relations = defineRelations(schema, (r) => ({
  users: {
    posts: r.many.posts({ from: r.users.id, to: r.posts.authorId, alias: 'authored' }),
    edited: r.many.posts({ from: r.users.id, to: r.posts.editorId, alias: 'edited' }),
  },
  posts: {
    // Every post has an author.
    author: r.one.users({ from: r.posts.authorId, to: r.users.id, optional: false, alias: 'authored' }),
    editor: r.one.users({ from: r.posts.editorId, to: r.users.id, alias: 'edited' }),
    parent: r.one.posts({ from: r.posts.parentId, to: r.posts.id, alias: 'thread' }),
    replies: r.many.posts({ from: r.posts.id, to: r.posts.parentId, alias: 'thread' }),
  },
}));`);
    expect(relations).toContain(`import { defineRelations } from 'drizzle-orm/relations';\nimport * as schema from './schema';`);
  });

  it('removes the relations() blocks and the relations import from the schema, keeping the rest', () => {
    const { schema } = convertRelations(SCHEMA);
    expect(schema).not.toContain('relations(');
    expect(schema).toContain(`import { sql } from 'drizzle-orm';`);
    expect(schema).not.toContain('Posts thread under a parent.');
    expect(schema).toContain("body: text('body').default(sql`''`),\n});\n\nexport type Post = typeof posts.$inferSelect;\n");
  });

  it('refuses a many() with no reverse one(), which v1 could not query either', () => {
    const { errors } = convertRelations(SCHEMA.replace(`  edited: many(posts, { relationName: 'edited' }),\n`, `  edited: many(posts, { relationName: 'nope' }),\n`));
    expect(errors).toEqual([`users.edited: many(posts, 'nope') has 0 reverse one() relations, need exactly 1`]);
  });

  it('writes composite keys as arrays', () => {
    const src = `import { relations } from 'drizzle-orm';
export const a = pgTable('a', { x: text('x').notNull(), y: text('y').notNull() });
export const b = pgTable('b', { ax: text('ax').notNull(), ay: text('ay') });
export const bRelations = relations(b, ({ one }) => ({
  a: one(a, { fields: [b.ax, b.ay], references: [a.x, a.y] }),
}));
`;
    const { relations, schema, errors } = convertRelations(src);
    expect(errors).toEqual([]);
    expect(relations).toContain('a: r.one.a({ from: [r.b.ax, r.b.ay], to: [r.a.x, r.a.y] }),');
    expect(schema.startsWith('import')).toBe(false);
  });
});

describe('convertDrizzleInit', () => {
  it('passes relations instead of schema and drops an unused schema import', () => {
    const src = `import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
let d: ReturnType<typeof drizzle<typeof schema>> | null = null;
d = drizzle({ client: c, schema });
`;
    expect(convertDrizzleInit(src)).toBe(`import { drizzle } from 'drizzle-orm/node-postgres';
import { relations } from './relations';
let d: ReturnType<typeof drizzle<typeof relations>> | null = null;
d = drizzle({ client: c, relations });
`);
  });

  it('keeps the schema import when something else still reads it', () => {
    const src = `import * as schema from '@buildd/core/db/schema';
const db = drizzle({ client: neon(url), schema });
const t = schema.tasks;
`;
    expect(convertDrizzleInit(src)).toBe(`import * as schema from '@buildd/core/db/schema';
import { relations } from '@buildd/core/db/relations';
const db = drizzle({ client: neon(url), relations });
const t = schema.tasks;
`);
  });

  it('handles a dynamic schema import', () => {
    const src = `async function main() {
  const schema = await import('../packages/core/db/schema');
  const db = drizzle({ client: neon(URL), schema });
}
`;
    expect(convertDrizzleInit(src)).toBe(`async function main() {
  const schema = await import('../packages/core/db/schema');
  const { relations } = await import('../packages/core/db/relations');
  const db = drizzle({ client: neon(URL), relations });
}
`);
  });

  it('handles a positional driver config', () => {
    const src = `it('x', async () => {
  const schema = await import('@buildd/core/db/schema');
  const offline = drizzle(async () => ({ rows: [] }), { schema });
});
`;
    expect(convertDrizzleInit(src)).toBe(`it('x', async () => {
  const schema = await import('@buildd/core/db/schema');
  const { relations } = await import('@buildd/core/db/relations');
  const offline = drizzle(async () => ({ rows: [] }), { relations });
});
`);
  });

  it('leaves a file without a schema-bearing init alone', () => {
    expect(convertDrizzleInit(`import * as schema from './schema';\nconst db = drizzle({ client });\n`)).toBeNull();
  });
});

describe('applyEdits', () => {
  it('keeps insertions at one position in registration order', () => {
    expect(applyEdits('ab', [{ pos: 1, end: 1, text: 'X' }, { pos: 1, end: 1, text: 'Y' }])).toBe('aXYb');
  });

  it('refuses overlapping replacements', () => {
    expect(() => applyEdits('abcdef', [{ pos: 0, end: 3, text: '' }, { pos: 2, end: 5, text: '' }])).toThrow('overlapping');
  });
});
