import Database from 'better-sqlite3';
import type { Database as BetterSQLite3Database } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function createDbClient(dbPath: string): Promise<{
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: BetterSQLite3Database;
}> {
  // Ensure directory exists before creating database
  const dir = dirname(dbPath);
  await mkdir(dir, { recursive: true });

  const sqlite = new Database(dbPath);

  // Set required pragmas in mandatory order (§5.4.3)
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('cache_size = -8000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('mmap_size = 134217728');

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

export type DbClient = Awaited<ReturnType<typeof createDbClient>>['db'];
