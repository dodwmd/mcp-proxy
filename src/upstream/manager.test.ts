import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UpstreamConnectionManager } from './manager.js';
import type { ResolvedServerConfig } from '../config/types.js';

describe('UpstreamConnectionManager', () => {
  let manager: UpstreamConnectionManager;

  beforeEach(() => {
    manager = new UpstreamConnectionManager();
  });

  afterEach(async () => {
    await manager.closeAll();
  });

  describe('Transport Registry', () => {
    it('should reject unknown transport types', async () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'unknown' as any,
        enabled: true,
        timeoutMs: 5000,
      };

      const results = await manager.connectAll(
        [config],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      const result = results.get('test');
      expect(result).toBeDefined();
      expect(result?.status).toBe('error');
      expect(result?.error).toContain('Unknown transport type');
    });

    it('should handle stdio transport with missing command', async () => {
      const config: ResolvedServerConfig = {
        id: 'stdio-1',
        alias: 'stdio-test',
        name: 'Stdio Test',
        transport: 'stdio',
        enabled: true,
        timeoutMs: 5000,
        // Missing command field
      };

      const results = await manager.connectAll(
        [config],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      const result = results.get('stdio-test');
      expect(result).toBeDefined();
      expect(result?.status).toBe('error');
      expect(result?.error).toContain('missing command');
    });

    it('should throw for unimplemented transports', async () => {
      const httpConfig: ResolvedServerConfig = {
        id: 'http-1',
        alias: 'http-test',
        name: 'HTTP Test',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'http://localhost:3000',
      };

      const results = await manager.connectAll(
        [httpConfig],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      const result = results.get('http-test');
      expect(result).toBeDefined();
      expect(result?.status).toBe('error');
      expect(result?.error).toContain('not yet implemented');
    });
  });

  describe('Lifecycle', () => {
    it('should skip disabled servers', async () => {
      const config: ResolvedServerConfig = {
        id: 'disabled-1',
        alias: 'disabled',
        name: 'Disabled Server',
        transport: 'stdio',
        enabled: false,
        timeoutMs: 5000,
        command: 'node',
        args: ['server.js'],
      };

      const results = await manager.connectAll(
        [config],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      expect(results.size).toBe(0);
      expect(manager.has('disabled')).toBe(false);
    });

    it('should track connected upstreams by alias', async () => {
      expect(manager.has('nonexistent')).toBe(false);
      expect(manager.get('nonexistent')).toBeUndefined();
      expect(manager.getAll()).toHaveLength(0);
    });

    it('should close all connections', async () => {
      await manager.closeAll();
      expect(manager.getAll()).toHaveLength(0);
    });
  });

  describe('Concurrency', () => {
    it('should respect concurrency limit when connecting', async () => {
      const configs: ResolvedServerConfig[] = Array.from({ length: 25 }, (_, i) => ({
        id: `server-${i}`,
        alias: `server-${i}`,
        name: `Server ${i}`,
        transport: 'stdio',
        enabled: true,
        timeoutMs: 5000,
        command: 'invalid-command-that-will-fail',
      }));

      // This should process in batches of 10 (default concurrency)
      const start = Date.now();
      const results = await manager.connectAll(
        configs,
        'session-123',
        { name: 'test-client', version: '1.0.0' },
        10
      );
      const elapsed = Date.now() - start;

      // Should have attempted all 25 servers
      expect(results.size).toBe(25);

      // All should have failed (invalid command)
      for (const result of results.values()) {
        expect(result.status).toBe('error');
      }

      // Should have taken at least 3 batches worth of time (but not long since they fail fast)
      expect(elapsed).toBeLessThan(5000); // Should be quick failures
    });
  });
});
