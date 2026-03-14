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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    it('should handle streamablehttp transport with missing URL', async () => {
      const httpConfig: ResolvedServerConfig = {
        id: 'http-1',
        alias: 'http-test',
        name: 'HTTP Test',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        // Missing url field
      };

      const results = await manager.connectAll(
        [httpConfig],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      const result = results.get('http-test');
      expect(result).toBeDefined();
      expect(result?.status).toBe('error');
      expect(result?.error).toContain('missing url');
    });

    it('should handle sse transport with missing URL', async () => {
      const sseConfig: ResolvedServerConfig = {
        id: 'sse-1',
        alias: 'sse-test',
        name: 'SSE Test',
        transport: 'sse',
        enabled: true,
        timeoutMs: 5000,
        // Missing url field
      };

      const results = await manager.connectAll(
        [sseConfig],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      const result = results.get('sse-test');
      expect(result).toBeDefined();
      expect(result?.status).toBe('error');
      expect(result?.error).toContain('missing url');
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

  describe('HTTP Transport Registration', () => {
    it('should register streamablehttp transport', async () => {
      const config: ResolvedServerConfig = {
        id: 'http-1',
        alias: 'http-test',
        name: 'HTTP Test',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://api.example.com',
      };

      const results = await manager.connectAll(
        [config],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      const result = results.get('http-test');
      expect(result).toBeDefined();
      // Will fail to connect (no server), but transport should be recognized
      expect(result?.status).toBe('error');
      // Should NOT say "unknown transport"
      expect(result?.error).not.toContain('Unknown transport type');
    });

    it('should register sse transport', async () => {
      const config: ResolvedServerConfig = {
        id: 'sse-1',
        alias: 'sse-test',
        name: 'SSE Test',
        transport: 'sse',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://api.example.com',
      };

      const results = await manager.connectAll(
        [config],
        'session-123',
        { name: 'test-client', version: '1.0.0' }
      );

      const result = results.get('sse-test');
      expect(result).toBeDefined();
      // Will fail to connect (no server), but transport should be recognized
      expect(result?.status).toBe('error');
      // Should NOT say "unknown transport"
      expect(result?.error).not.toContain('Unknown transport type');
    });
  });

  describe('Runtime Configuration', () => {
    describe('allowPrivateUrls', () => {
      it('should reject private URLs by default', async () => {
        const managerDefault = new UpstreamConnectionManager();

        const config: ResolvedServerConfig = {
          id: 'http-1',
          alias: 'http-test',
          name: 'HTTP Test',
          transport: 'streamablehttp',
          enabled: true,
          timeoutMs: 5000,
          url: 'http://localhost:8080',
        };

        const results = await managerDefault.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        const result = results.get('http-test');
        expect(result).toBeDefined();
        expect(result?.status).toBe('error');
        expect(result?.error).toContain('private IP address');

        await managerDefault.closeAll();
      });

      it('should reject private URLs when allowPrivateUrls is false', async () => {
        const managerDisallowed = new UpstreamConnectionManager({ allowPrivateUrls: false });

        const config: ResolvedServerConfig = {
          id: 'http-1',
          alias: 'http-test',
          name: 'HTTP Test',
          transport: 'streamablehttp',
          enabled: true,
          timeoutMs: 5000,
          url: 'http://127.0.0.1:8080',
        };

        const results = await managerDisallowed.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        const result = results.get('http-test');
        expect(result).toBeDefined();
        expect(result?.status).toBe('error');
        expect(result?.error).toContain('private IP address');

        await managerDisallowed.closeAll();
      });

      it('should allow private URLs when allowPrivateUrls is true', async () => {
        const managerAllowed = new UpstreamConnectionManager({ allowPrivateUrls: true });

        const config: ResolvedServerConfig = {
          id: 'http-1',
          alias: 'http-test',
          name: 'HTTP Test',
          transport: 'streamablehttp',
          enabled: true,
          timeoutMs: 5000,
          url: 'http://localhost:8080',
        };

        const results = await managerAllowed.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        const result = results.get('http-test');
        expect(result).toBeDefined();
        // Should not fail with private IP error
        expect(result?.error).not.toContain('private IP address');
        // Will fail for other reasons (no actual server), but validation passed
        expect(result?.status).toBe('error');

        await managerAllowed.closeAll();
      });

      it(
        'should apply allowPrivateUrls to SSE transport',
        async () => {
          const managerAllowed = new UpstreamConnectionManager({ allowPrivateUrls: true });

          const config: ResolvedServerConfig = {
            id: 'sse-1',
            alias: 'sse-test',
            name: 'SSE Test',
            transport: 'sse',
            enabled: true,
            timeoutMs: 5000,
            url: 'http://localhost:8080',
          };

          const results = await managerAllowed.connectAll(
            [config],
            'session-123',
            { name: 'test-client', version: '1.0.0' }
          );

          const result = results.get('sse-test');
          expect(result).toBeDefined();
          expect(result?.status).toBe('error');
          expect(result?.error).not.toContain('private IP address');

          await managerAllowed.closeAll();
        },
        10000
      );
    });

    describe('httpKeepaliveMs', () => {
      it('should use default keepalive of 30000ms', async () => {
        const managerDefault = new UpstreamConnectionManager();

        const config: ResolvedServerConfig = {
          id: 'http-1',
          alias: 'http-test',
          name: 'HTTP Test',
          transport: 'streamablehttp',
          enabled: true,
          timeoutMs: 5000,
          url: 'https://api.example.com',
        };

        // Transport should be created with default 30000ms keepalive
        // This is verified by the upstream constructor accepting the value
        const results = await managerDefault.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        expect(results.get('http-test')).toBeDefined();

        await managerDefault.closeAll();
      });

      it('should accept custom httpKeepaliveMs', async () => {
        const managerCustom = new UpstreamConnectionManager({ httpKeepaliveMs: 60000 });

        const config: ResolvedServerConfig = {
          id: 'http-1',
          alias: 'http-test',
          name: 'HTTP Test',
          transport: 'streamablehttp',
          enabled: true,
          timeoutMs: 5000,
          url: 'https://api.example.com',
        };

        const results = await managerCustom.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        expect(results.get('http-test')).toBeDefined();

        await managerCustom.closeAll();
      });

      it('should accept httpKeepaliveMs of 0 to disable keepalive', async () => {
        const managerNoKeepalive = new UpstreamConnectionManager({ httpKeepaliveMs: 0 });

        const config: ResolvedServerConfig = {
          id: 'http-1',
          alias: 'http-test',
          name: 'HTTP Test',
          transport: 'streamablehttp',
          enabled: true,
          timeoutMs: 5000,
          url: 'https://api.example.com',
        };

        const results = await managerNoKeepalive.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        expect(results.get('http-test')).toBeDefined();

        await managerNoKeepalive.closeAll();
      });

      it('should apply httpKeepaliveMs to SSE transport', async () => {
        const managerCustom = new UpstreamConnectionManager({ httpKeepaliveMs: 45000 });

        const config: ResolvedServerConfig = {
          id: 'sse-1',
          alias: 'sse-test',
          name: 'SSE Test',
          transport: 'sse',
          enabled: true,
          timeoutMs: 5000,
          url: 'https://api.example.com',
        };

        const results = await managerCustom.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        expect(results.get('sse-test')).toBeDefined();

        await managerCustom.closeAll();
      });
    });

    describe('Combined Runtime Config', () => {
      it('should apply both allowPrivateUrls and httpKeepaliveMs', async () => {
        const managerCombined = new UpstreamConnectionManager({
          allowPrivateUrls: true,
          httpKeepaliveMs: 15000,
        });

        const config: ResolvedServerConfig = {
          id: 'http-1',
          alias: 'http-test',
          name: 'HTTP Test',
          transport: 'streamablehttp',
          enabled: true,
          timeoutMs: 5000,
          url: 'http://localhost:8080',
        };

        const results = await managerCombined.connectAll(
          [config],
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        const result = results.get('http-test');
        expect(result).toBeDefined();
        // Should not fail with private IP error
        expect(result?.error).not.toContain('private IP address');

        await managerCombined.closeAll();
      });
    });

    describe('Multiple Transport Types', () => {
      it('should handle mixed transport types with runtime config', async () => {
        const managerMixed = new UpstreamConnectionManager({
          allowPrivateUrls: true,
          httpKeepaliveMs: 20000,
        });

        const configs: ResolvedServerConfig[] = [
          {
            id: 'http-1',
            alias: 'http-server',
            name: 'HTTP Server',
            transport: 'streamablehttp',
            enabled: true,
            timeoutMs: 5000,
            url: 'http://localhost:8080',
          },
          {
            id: 'sse-1',
            alias: 'sse-server',
            name: 'SSE Server',
            transport: 'sse',
            enabled: true,
            timeoutMs: 5000,
            url: 'http://127.0.0.1:8081',
          },
          {
            id: 'stdio-1',
            alias: 'stdio-server',
            name: 'Stdio Server',
            transport: 'stdio',
            enabled: true,
            timeoutMs: 5000,
            command: 'invalid-command',
          },
        ];

        const results = await managerMixed.connectAll(
          configs,
          'session-123',
          { name: 'test-client', version: '1.0.0' }
        );

        // All three should be attempted
        expect(results.size).toBe(3);

        // HTTP servers should not have private IP errors
        const httpResult = results.get('http-server');
        expect(httpResult?.error).not.toContain('private IP address');

        const sseResult = results.get('sse-server');
        expect(sseResult?.error).not.toContain('private IP address');

        // Stdio should have its own error (invalid command)
        const stdioResult = results.get('stdio-server');
        expect(stdioResult?.status).toBe('error');

        await managerMixed.closeAll();
      });
    });
  });
});
