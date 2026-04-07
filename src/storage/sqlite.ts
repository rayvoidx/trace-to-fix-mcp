import initSqlJs, { type Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database | null = null;
let dbPath: string;

function getDbPath(): string {
  return process.env.CACHE_DB_PATH ?? "./cache/analysis.db";
}

export async function getDb(): Promise<Database> {
  if (db) return db;

  dbPath = resolve(getDbPath());
  mkdirSync(dirname(dbPath), { recursive: true });

  const SQL = await initSqlJs();

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  const schema = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  db.run(schema);
  persist();

  return db;
}

function persist(): void {
  if (!db) return;
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

export async function cacheGet(type: string, key: string): Promise<unknown | null> {
  const d = await getDb();
  const stmt = d.prepare(
    `SELECT data FROM analysis_cache
     WHERE type = ? AND key = ?
     AND (expires_at IS NULL OR expires_at > datetime('now'))`,
  );
  stmt.bind([type, key]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return JSON.parse(row.data as string);
  }
  stmt.free();
  return null;
}

export async function cacheSet(
  type: string,
  key: string,
  data: unknown,
  ttlMinutes?: number,
): Promise<void> {
  const d = await getDb();
  const id = `${type}:${key}`;
  const expiresAt = ttlMinutes
    ? new Date(Date.now() + ttlMinutes * 60_000).toISOString()
    : null;

  d.run(
    `INSERT OR REPLACE INTO analysis_cache (id, type, key, data, created_at, expires_at)
     VALUES (?, ?, ?, ?, datetime('now'), ?)`,
    [id, type, key, JSON.stringify(data), expiresAt],
  );
  persist();
}

export async function saveCluster(
  clusterId: string,
  fingerprint: string,
  data: unknown,
): Promise<void> {
  const d = await getDb();
  d.run(
    `INSERT OR REPLACE INTO clusters (cluster_id, fingerprint, data, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [clusterId, fingerprint, JSON.stringify(data)],
  );
  persist();
}

export async function getCluster(clusterId: string): Promise<unknown | null> {
  const d = await getDb();
  const stmt = d.prepare(`SELECT data FROM clusters WHERE cluster_id = ?`);
  stmt.bind([clusterId]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return JSON.parse(row.data as string);
  }
  stmt.free();
  return null;
}
