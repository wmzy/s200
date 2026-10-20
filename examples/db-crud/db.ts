/**
 * The persistence slice: SQLite through Node's built-in `node:sqlite`
 * module — a real database with zero npm dependencies.
 *
 * `DatabaseSync` is synchronous (each call blocks until SQLite answers —
 * fine for a demo and for small fast queries; pool a worker for hot async
 * paths). Statements are compiled once via `prepare` and reused, and
 * values reach SQL only through `?` parameter binding — never string
 * interpolation.
 */
import { DatabaseSync } from 'node:sqlite';

/** The row shape the routes speak. */
export type User = { id: number; name: string; email: string };

/** Everything the routes need from the database — a handful of functions. */
export type UserStore = {
  list(): User[];
  find(id: number): User | undefined;
  create(input: Omit<User, 'id'>): User;
  update(id: number, input: Omit<User, 'id'>): User | undefined;
  remove(id: number): boolean;
};

/** node:sqlite hands rows back as `SQLOutputValue` records (with a null
 * prototype) — coerce to `User` at this boundary so the app sees real
 * types. The NOT NULL columns guarantee the three fields exist. */
const toUser = (row: Record<string, unknown>): User => ({
  id: Number(row.id),
  name: String(row.name),
  email: String(row.email),
});

/** SQLite raises `ERR_SQLITE_ERROR` for constraint violations; the routes
 * map the UNIQUE flavor (a duplicate email) to 409 Conflict. */
export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' &&
  String((error as { message?: unknown }).message).includes('UNIQUE constraint failed');

/**
 * Opens (or creates) the database — `:memory:` by default, a file path for
 * a database that survives restarts (`DB_PATH=users.db pnpm start`).
 * `CREATE TABLE IF NOT EXISTS` plus count-based seeding make reopening a
 * file database idempotent.
 */
export const openUserStore = (path = ':memory:'): UserStore => {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    )
  `);
  // COUNT(*) always answers exactly one row — the undefined branch of
  // `.get()` is unreachable here.
  const seeded = db.prepare('SELECT COUNT(*) AS n FROM users').get() as {
    n: number;
  };
  if (seeded.n === 0) {
    const seed = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
    seed.run('ada lovelace', 'ada@example.com');
    seed.run('alan turing', 'alan@example.com');
  }

  const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
  const selectById = db.prepare('SELECT id, name, email FROM users WHERE id = ?');
  const selectAll = db.prepare('SELECT id, name, email FROM users ORDER BY id');
  const updateById = db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?');
  const deleteById = db.prepare('DELETE FROM users WHERE id = ?');

  return {
    list: () => selectAll.all().map(toUser),
    find: (id) => {
      const row = selectById.get(id);
      return row === undefined ? undefined : toUser(row);
    },
    create: (input) => {
      // run() reports `lastInsertRowid` as number | bigint — Number()
      // coerces (ids only leave the safe range after 2^53 inserts).
      const result = insert.run(input.name, input.email);
      return { id: Number(result.lastInsertRowid), ...input };
    },
    update: (id, input) => {
      const result = updateById.run(input.name, input.email, id);
      return Number(result.changes) === 0 ? undefined : { id, ...input };
    },
    remove: (id) => Number(deleteById.run(id).changes) > 0,
  };
};
