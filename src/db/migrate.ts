import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDbClient } from './client.js';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export interface MigrateOptions {
  dbPath: string;
  migrationPrompt?: 'never' | 'always' | 'interactive';
  migrationsFolder?: string;
}

/**
 * Run database migrations.
 * Handles prompt modes: never (auto-apply), always (always prompt), interactive (prompt if needed).
 */
export async function runMigrations(options: MigrateOptions): Promise<void> {
  const {
    dbPath,
    migrationPrompt = 'interactive',
    migrationsFolder = './drizzle',
  } = options;

  const { db, sqlite } = createDbClient(dbPath);

  try {
    // Check if migrations are needed
    const pendingMigrations = await checkPendingMigrations(sqlite, migrationsFolder);

    if (pendingMigrations === 0) {
      console.log('[INFO] Database schema is up to date');
      return;
    }

    console.log(`[INFO] ${pendingMigrations} pending migration(s) detected`);

    // Handle prompt mode
    let shouldApply = true;

    if (migrationPrompt === 'always' || (migrationPrompt === 'interactive' && pendingMigrations > 0)) {
      shouldApply = await promptForMigration(pendingMigrations);
    }

    if (!shouldApply) {
      console.log('[INFO] Migrations cancelled by user');
      process.exit(1);
    }

    // Apply migrations
    console.log('[INFO] Applying migrations...');
    await migrate(db, { migrationsFolder });
    console.log('[INFO] Migrations applied successfully');
  } catch (error) {
    console.error('[ERROR] Migration failed:', error);
    throw error;
  } finally {
    sqlite.close();
  }
}

/**
 * Check how many pending migrations exist.
 * Returns count of migrations not yet applied.
 */
async function checkPendingMigrations(
  sqlite: any,
  migrationsFolder: string
): Promise<number> {
  // Check if migrations journal table exists
  const tableExists = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`
    )
    .get();

  if (!tableExists) {
    // No migrations table = fresh database, count all migration files
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    try {
      const files = await fs.readdir(migrationsFolder);
      const sqlFiles = files.filter((f) => f.endsWith('.sql'));
      return sqlFiles.length;
    } catch {
      // Migrations folder doesn't exist yet
      return 0;
    }
  }

  // Table exists, check applied migrations
  const appliedMigrations = sqlite
    .prepare(`SELECT hash FROM __drizzle_migrations`)
    .all();

  const fs = await import('node:fs/promises');
  try {
    const files = await fs.readdir(migrationsFolder);
    const sqlFiles = files.filter((f) => f.endsWith('.sql'));
    return sqlFiles.length - appliedMigrations.length;
  } catch {
    return 0;
  }
}

/**
 * Prompt user to confirm migration.
 */
async function promptForMigration(pendingCount: number): Promise<boolean> {
  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question(
      `Apply ${pendingCount} pending migration(s)? This will modify the database schema. (y/N): `
    );
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * CLI entry point for standalone migration script.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.DATABASE_URL || `${process.env.HOME}/.mcp-aggregator/db.sqlite`;
  const migrationPrompt = (process.env.MIGRATION_PROMPT as 'never' | 'always' | 'interactive') || 'interactive';

  runMigrations({ dbPath, migrationPrompt })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
