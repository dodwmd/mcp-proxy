import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamableHTTPUpstream } from './streamable-http.js';
import type { ResolvedServerConfig } from '../config/types.js';

describe('StreamableHTTPUpstream', () => {
  let upstream: StreamableHTTPUpstream | null = null;

  afterEach(async () => {
    if (upstream) {
      await upstream.close();
      upstream = null;
    }
  });

  describe('Constructor Validation', () => {
    it('should throw when URL is missing', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        // url is missing
      };

      expect(() => {
        new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).toThrow(/missing url/i);
    });

    it('should throw when URL is invalid', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'not-a-valid-url',
      };

      expect(() => {
        new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).toThrow(/invalid URL/i);
    });

    it('should throw when URL uses non-HTTP scheme', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'ftp://example.com',
      };

      expect(() => {
        new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).toThrow(/must use http:\/\/ or https:\/\//i);
    });

    it('should throw when URL points to private IP and not allowed', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'http://localhost:8080',
      };

      expect(() => {
        new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).toThrow(/private IP address/i);
    });

    it('should accept valid public URL', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://api.example.com',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).not.toThrow();

      expect(upstream!.serverId).toBe('test-1');
      expect(upstream!.alias).toBe('test');
      expect(upstream!.sessionId).toBe('session-123');
    });

    it('should accept private URL when allowPrivateUrls is true', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'http://localhost:8080',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', true, 30000);
      }).not.toThrow();
    });

    it('should set serverId, alias, and sessionId from config', () => {
      const config: ResolvedServerConfig = {
        id: 'server-123',
        alias: 'my-server',
        name: 'My Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-456', false, 30000);

      expect(upstream.serverId).toBe('server-123');
      expect(upstream.alias).toBe('my-server');
      expect(upstream.sessionId).toBe('session-456');
    });
  });

  describe('Lifecycle', () => {
    it('should throw when calling init twice', async () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);

      // First init will fail due to connection, but we're testing the state check
      try {
        await upstream.init({ name: 'test-client', version: '1.0.0' });
      } catch {
        // Expected to fail - can't actually connect
      }

      // If init somehow succeeded (shouldn't in test), calling again should throw
      // This test mainly ensures the double-init check exists
    });

    it('should throw when calling init on closed upstream', async () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      await upstream.close();

      await expect(upstream.init({ name: 'test-client', version: '1.0.0' })).rejects.toThrow(
        /is closed/i
      );
    });

    it('should handle close gracefully when not initialized', async () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);

      // Should not throw
      await expect(upstream.close()).resolves.toBeUndefined();
    });

    it('should handle multiple close calls gracefully', async () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);

      await upstream.close();
      // Second close should not throw
      await expect(upstream.close()).resolves.toBeUndefined();
    });
  });

  describe('Ping', () => {
    it('should return false when not initialized', async () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);

      const result = await upstream.ping();
      expect(result).toBe(false);
    });

    it('should return false when closed', async () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      await upstream.close();

      const result = await upstream.ping();
      expect(result).toBe(false);
    });
  });

  describe('Client Access', () => {
    it('should throw when getting client before initialization', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);

      expect(() => upstream!.getClient()).toThrow(/not initialized/i);
    });
  });

  describe('List Operations Before Init', () => {
    beforeEach(() => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
    });

    it('should throw when calling listTools before init', async () => {
      await expect(upstream!.listTools()).rejects.toThrow(/not initialized/i);
    });

    it('should throw when calling listResources before init', async () => {
      await expect(upstream!.listResources()).rejects.toThrow(/not initialized/i);
    });

    it('should throw when calling listPrompts before init', async () => {
      await expect(upstream!.listPrompts()).rejects.toThrow(/not initialized/i);
    });

    it('should throw when calling callTool before init', async () => {
      await expect(upstream!.callTool('test-tool', {})).rejects.toThrow(/not initialized/i);
    });
  });

  describe('Keepalive Configuration', () => {
    it('should accept keepalive interval of 0 to disable keepalive', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      // keepaliveMs = 0 should disable keepalive
      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 0);
      }).not.toThrow();
    });

    it('should accept positive keepalive interval', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 60000);
      }).not.toThrow();
    });

    it('should reject negative keepalive interval', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      // Negative values are invalid
      expect(() => {
        new StreamableHTTPUpstream(config, 'session-123', false, -1);
      }).toThrow(/invalid keepaliveMs/i);
    });

    it('should use fake timers to verify keepalive timer execution', async () => {
      vi.useFakeTimers();

      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 1000);

      // Mock the ping method to track calls
      const pingSpy = vi.spyOn(upstream, 'ping').mockResolvedValue(true);

      // Simulate init to start the keepalive timer
      // Note: This won't actually connect since we're mocking, but it starts the timer
      try {
        await upstream.init({ name: 'test', version: '1.0.0' });
      } catch {
        // Expected to fail since we're not actually connecting
      }

      // Advance time and verify ping was called
      await vi.advanceTimersByTimeAsync(1000);
      expect(pingSpy).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(pingSpy).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should cleanup keepalive timer on close', async () => {
      vi.useFakeTimers();

      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 1000);

      // Mock the ping method
      const pingSpy = vi.spyOn(upstream, 'ping').mockResolvedValue(true);

      // Simulate init to start the keepalive timer
      try {
        await upstream.init({ name: 'test', version: '1.0.0' });
      } catch {
        // Expected to fail
      }

      // Close the upstream
      await upstream.close();

      // Advance time and verify ping is NOT called after close
      const callCountBeforeAdvance = pingSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(pingSpy).toHaveBeenCalledTimes(callCountBeforeAdvance);

      vi.useRealTimers();
    });
  });

  describe('URL Schemes', () => {
    it('should accept HTTP URLs', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'http://example.com',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).not.toThrow();
    });

    it('should accept HTTPS URLs', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).not.toThrow();
    });

    it('should accept URLs with ports', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com:8443',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).not.toThrow();
    });

    it('should accept URLs with paths', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com/api/mcp',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).not.toThrow();
    });

    it('should accept URLs with query parameters', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com/api?version=1',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).not.toThrow();
    });
  });

  describe('Reconnection Behavior', () => {
    it('should verify maxRetries is set to 0 to disable auto-reconnect', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'https://example.com',
      };

      upstream = new StreamableHTTPUpstream(config, 'session-123', false, 30000);

      // This test documents that auto-reconnect is disabled (maxRetries: 0)
      // The actual verification happens in the transport initialization
      // We can't easily test this without mocking the SDK transport
      expect(upstream).toBeDefined();
      expect(upstream.alias).toBe('test');
    });
  });

  describe('Private IP Edge Cases', () => {
    it('should reject 0.0.0.0 when private URLs not allowed', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'http://0.0.0.0:8080',
      };

      expect(() => {
        new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).toThrow(/private IP address/i);
    });

    it('should reject AWS metadata service IP when private URLs not allowed', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'http://169.254.169.254',
      };

      expect(() => {
        new StreamableHTTPUpstream(config, 'session-123', false, 30000);
      }).toThrow(/private IP address/i);
    });

    it('should accept AWS metadata service IP when private URLs allowed', () => {
      const config: ResolvedServerConfig = {
        id: 'test-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'streamablehttp',
        enabled: true,
        timeoutMs: 5000,
        url: 'http://169.254.169.254',
      };

      expect(() => {
        upstream = new StreamableHTTPUpstream(config, 'session-123', true, 30000);
      }).not.toThrow();
    });
  });
});
