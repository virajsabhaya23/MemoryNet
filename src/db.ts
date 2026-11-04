import { mkdir, readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { ConflictError } from "./errors.ts";
import { lockDatabase } from "./database-lock.ts";

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

/** Opens embedded PostgreSQL (PGlite). Without a data directory the database lives only in memory. */
export async function openDatabase(dataDir?: string): Promise<Database> {
  // PGlite creates only the last folder of the path.
  if (dataDir !== undefined) await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const release = dataDir === undefined ? async () => {} : await lockDatabase(dataDir);
  let db: PGlite | undefined;
  try {
    db = new PGlite(dataDir);
    await db.waitReady;
    const connection = db;
    let closing: Promise<void> | undefined;
    return {
      query: (sql, params) => connection.query(sql, params),
      exec: (sql) => connection.exec(sql),
      transaction: (fn) => connection.transaction(fn),
      close: () => closing ??= (async () => { await connection.close(); await release(); })(),
    };
  } catch (error) {
    if (db) await db.close().catch(() => {});
    await release();
    throw error;
  }
}

/** Migration file names in the order they apply. */
export async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
}

/** How many migrations a database has applied and which are still pending, without changing it. */
export async function pendingMigrations(db: Queryable): Promise<{ applied: number; pending: string[] }> {
  const table = (await db.query<{ name: string | null }>("SELECT to_regclass('schema_migrations')::text AS name")).rows[0]?.name;
  const applied = new Set(table ? (await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((row) => row.name) : []);
  return { applied: applied.size, pending: (await migrationFiles()).filter((file) => !applied.has(file)) };
}

/** Applies pending migrations/*.sql files in name order, each in its own transaction. */
export async function migrate(db: Database): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await db.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.name));
  const files = await migrationFiles();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

export function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Expected a database row");
  return row;
}

/** Runs an INSERT ... RETURNING and turns a unique-key clash into a ConflictError. */
export async function insertReturning<T>(
  q: Queryable,
  sql: string,
  params: unknown[],
  conflictMessage: string,
): Promise<T> {
  try {
    return firstRow((await q.query<T>(sql, params)).rows);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(conflictMessage);
    throw error;
  }
}
