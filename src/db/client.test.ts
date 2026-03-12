import { describe, it, expect, afterEach } from 'vitest';
import { createDbClient } from './client.js';
import { unlink, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Database Client', () => {
  const testDbPaths: string[] = [];

  afterEach(async () => {
    // Clean up test databases
    for (const dbPath of testDbPaths) {
      try {
        await unlink(dbPath);
        await unlink(`${dbPath}-shm`);
        await unlink(`${dbPath}-wal`);
      } catch {
        // Ignore errors if files don't exist
      }

      // Clean up test directory
      try {
        const dir = path.dirname(dbPath);
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore errors if directory doesn't exist
      }
    }
    testDbPaths.length = 0;
  });

  describe('Directory Creation', () => {
    it('should create nested directory structure if it does not exist', async () => {
      // Regression test for PAP-49: Database initialization race condition
      // This test ensures directory creation completes before database initialization
      const testDir = path.join(os.tmpdir(), 'mcp-test-db-' + Date.now(), 'nested', 'path');
      const dbPath = path.join(testDir, 'test.db');
      testDbPaths.push(dbPath);

      // Should not throw even though nested directories don't exist
      const { db, sqlite } = await createDbClient(dbPath);

      expect(db).toBeDefined();
      expect(sqlite).toBeDefined();

      // Verify database file was created
      const info = sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(info.journal_mode).toBe('wal');

      sqlite.close();
    });

    it('should handle concurrent database creation in same directory', async () => {
      // Tests that multiple database creations in same directory work correctly
      const testDir = path.join(os.tmpdir(), 'mcp-test-db-concurrent-' + Date.now());
      const db1Path = path.join(testDir, 'db1.db');
      const db2Path = path.join(testDir, 'db2.db');
      testDbPaths.push(db1Path, db2Path);

      // Create both databases concurrently
      const [result1, result2] = await Promise.all([
        createDbClient(db1Path),
        createDbClient(db2Path),
      ]);

      expect(result1.db).toBeDefined();
      expect(result2.db).toBeDefined();

      result1.sqlite.close();
      result2.sqlite.close();
    });

    it('should create database successfully if directory already exists', async () => {
      const testDir = path.join(os.tmpdir(), 'mcp-test-db-existing-' + Date.now());
      const dbPath = path.join(testDir, 'test.db');
      testDbPaths.push(dbPath);

      // Create directory first
      const { mkdir } = await import('node:fs/promises');
      await mkdir(testDir, { recursive: true });

      // Should work even though directory already exists
      const { db, sqlite } = await createDbClient(dbPath);

      expect(db).toBeDefined();
      expect(sqlite).toBeDefined();

      sqlite.close();
    });
  });

  describe('Database Configuration', () => {
    it('should set required SQLite pragmas', async () => {
      const testDir = path.join(os.tmpdir(), 'mcp-test-db-pragmas-' + Date.now());
      const dbPath = path.join(testDir, 'test.db');
      testDbPaths.push(dbPath);

      const { sqlite } = await createDbClient(dbPath);

      // Verify critical pragmas are set
      const journalMode = sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(journalMode.journal_mode).toBe('wal');

      const foreignKeys = sqlite.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(foreignKeys.foreign_keys).toBe(1);

      const synchronous = sqlite.prepare('PRAGMA synchronous').get() as { synchronous: number };
      expect(synchronous.synchronous).toBe(1); // NORMAL = 1

      sqlite.close();
    });
  });
});
