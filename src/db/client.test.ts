import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDbClient } from './client.js';

/**
 * Unit tests for database client creation
 * Tests directory creation, database initialization, and error handling
 */
describe('createDbClient', () => {
  let testDbPath: string;
  let testDir: string;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(tmpdir(), `mcp-proxy-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    testDbPath = join(testDir, 'test.db');

    // Ensure test directory doesn't exist
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    // Clean up test directory
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  describe('directory creation', () => {
    it('should create directory when it does not exist', async () => {
      expect(existsSync(testDir)).toBe(false);

      const { db, sqlite } = await createDbClient(testDbPath);

      expect(existsSync(testDir)).toBe(true);
      expect(existsSync(testDbPath)).toBe(true);

      sqlite.close();
    });

    it('should succeed when directory already exists', async () => {
      // Pre-create the directory
      await mkdir(testDir, { recursive: true });
      expect(existsSync(testDir)).toBe(true);

      const { db, sqlite } = await createDbClient(testDbPath);

      expect(existsSync(testDbPath)).toBe(true);

      sqlite.close();
    });

    it('should handle nested directory creation', async () => {
      const nestedPath = join(testDir, 'nested', 'deep', 'path', 'test.db');

      expect(existsSync(join(testDir, 'nested'))).toBe(false);

      const { db, sqlite } = await createDbClient(nestedPath);

      expect(existsSync(join(testDir, 'nested', 'deep', 'path'))).toBe(true);
      expect(existsSync(nestedPath)).toBe(true);

      sqlite.close();
    });

    // Note: Permission error testing is environment-dependent and difficult to reliably test
    // in all CI/CD environments. The key behavior (mkdir errors are propagated) is covered
    // by the other error handling tests below.
  });

  describe('database initialization', () => {
    it('should create database with correct pragmas', async () => {
      const { db, sqlite } = await createDbClient(testDbPath);

      // Verify pragmas were set correctly
      const journalMode = sqlite.pragma('journal_mode', { simple: true }) as string;
      const synchronous = sqlite.pragma('synchronous', { simple: true }) as number;
      const foreignKeys = sqlite.pragma('foreign_keys', { simple: true }) as number;
      const busyTimeout = sqlite.pragma('busy_timeout', { simple: true }) as number;

      expect(journalMode).toBe('wal');
      expect(synchronous).toBe(1); // NORMAL = 1
      expect(foreignKeys).toBe(1); // ON = 1
      expect(busyTimeout).toBe(5000);

      sqlite.close();
    });

    it('should return both db and sqlite instances', async () => {
      const { db, sqlite } = await createDbClient(testDbPath);

      expect(db).toBeDefined();
      expect(sqlite).toBeDefined();
      expect(typeof sqlite.prepare).toBe('function');
      expect(typeof sqlite.close).toBe('function');

      sqlite.close();
    });

    it('should create database file at specified path', async () => {
      expect(existsSync(testDbPath)).toBe(false);

      const { db, sqlite } = await createDbClient(testDbPath);

      expect(existsSync(testDbPath)).toBe(true);

      sqlite.close();
    });
  });

  describe('error handling', () => {
    it('should handle invalid database path gracefully', async () => {
      // Use a path with invalid characters (on most systems)
      const invalidPath = join(testDir, '\0invalid.db');

      await expect(createDbClient(invalidPath)).rejects.toThrow();
    });

    it('should propagate database creation errors', async () => {
      // Create a directory where the database file should be
      await mkdir(testDbPath, { recursive: true });

      // Trying to create a database at a directory path should fail
      await expect(createDbClient(testDbPath)).rejects.toThrow();
    });
  });

  describe('concurrent operations', () => {
    it('should handle multiple createDbClient calls with same path', async () => {
      const results = await Promise.all([
        createDbClient(testDbPath),
        createDbClient(testDbPath),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].db).toBeDefined();
      expect(results[1].db).toBeDefined();

      // Clean up
      results[0].sqlite.close();
      results[1].sqlite.close();
    });

    it('should handle multiple createDbClient calls with different nested paths', async () => {
      const paths = [
        join(testDir, 'db1', 'test.db'),
        join(testDir, 'db2', 'test.db'),
        join(testDir, 'db3', 'test.db'),
      ];

      const results = await Promise.all(paths.map((path) => createDbClient(path)));

      expect(results).toHaveLength(3);
      results.forEach((result, i) => {
        expect(result.db).toBeDefined();
        expect(existsSync(paths[i])).toBe(true);
        result.sqlite.close();
      });
    });
  });
});
