/**
 * Database schema
 * M0: Minimal schema for migrations tracking only
 * M1+: Add agent, guild, server tables
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Drizzle migrations tracking table
export const __drizzle_migrations = sqliteTable('__drizzle_migrations', {
  id: integer('id').primaryKey(),
  hash: text('hash').notNull(),
  created_at: integer('created_at').notNull(),
});
