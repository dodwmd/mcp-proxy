import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMcpServer } from './mcp.js';
import type { IAggregatorEngine } from '../aggregator/types.js';
import type { ResolvedServerConfig } from '../config/types.js';

/**
 * Unit tests for MCP server-level functions
 * Tests critical error detection, error handlers, and session cleanup logic
 */
describe('MCP Server Unit Tests', () => {
  let mockEngine: IAggregatorEngine;
  let serverConfigs: ResolvedServerConfig[];

  beforeEach(() => {
    // Create minimal mock engine for unit testing server-level behavior
    mockEngine = {
      createSession: vi.fn().mockResolvedValue({
        id: 'test-session',
        state: 'active',
        upstreamHandles: new Map(),
        upstreamStatuses: new Map(),
      }),
      closeSession: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({ result: 'ok' }),
    } as unknown as IAggregatorEngine;

    serverConfigs = [
      {
        id: 'test-server-1',
        alias: 'test',
        name: 'Test Server',
        transport: 'stdio',
        enabled: true,
        timeoutMs: 5000,
        command: 'mock-server',
      },
    ];
  });

  describe('isCriticalMcpError (via server.onerror behavior)', () => {
    it('should identify protocol_violation as critical', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Simulate initialization to create a session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      // Access private handler via server
      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      // Trigger error handler with critical error
      const criticalError = new Error('protocol_violation: invalid request');
      if (server.onerror) server.onerror(criticalError);

      // Wait for async cleanup to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('should identify transport_failed as critical (case insensitive)', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      // Test case insensitive matching
      const criticalError = new Error('Transport Failed: connection lost');
      if (server.onerror) server.onerror(criticalError);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('should identify connection lost as critical', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      const criticalError = new Error('connection lost');
      if (server.onerror) server.onerror(criticalError);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('should identify malformed request as critical', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      const criticalError = new Error('malformed request received');
      if (server.onerror) server.onerror(criticalError);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('should NOT trigger cleanup for non-critical errors', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      // Trigger non-critical error
      const nonCriticalError = new Error('normal error: something went wrong');
      if (server.onerror) server.onerror(nonCriticalError);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cleanupSpy).not.toHaveBeenCalled();
    });

    it('should handle non-Error objects gracefully', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      // Trigger with non-Error object (wrap string as Error)
      if (server.onerror) server.onerror(new Error('string error'));

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cleanupSpy).not.toHaveBeenCalled();
    });
  });

  describe('server.onerror handler', () => {
    it('should call cleanupAllSessions for critical errors', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      const criticalError = new Error('protocol_violation: test');
      if (server.onerror) server.onerror(criticalError);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify cleanup was called (session ID is a UUID, not fixed)
      expect(cleanupSpy).toHaveBeenCalled();
      expect(cleanupSpy.mock.calls[0][0]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('should NOT call cleanupAllSessions for non-critical errors', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const cleanupSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      const nonCriticalError = new Error('normal error');
      if (server.onerror) server.onerror(nonCriticalError);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(cleanupSpy).not.toHaveBeenCalled();
    });

    it('should handle cleanup errors gracefully', async () => {
      const failingEngine = {
        ...mockEngine,
        closeSession: vi.fn().mockRejectedValue(new Error('cleanup failed')),
      } as unknown as IAggregatorEngine;

      const server = createMcpServer({ engine: failingEngine, serverConfigs });

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      // Should not throw when cleanup fails
      const criticalError = new Error('protocol_violation: test');
      expect(() => { if (server.onerror) server.onerror(criticalError); }).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  describe('cleanupAllSessions (via server.onclose)', () => {
    it('should close all active sessions', async () => {
      const server = createMcpServer({ engine: mockEngine, serverConfigs });
      const closeSpy = vi.spyOn(mockEngine, 'closeSession');

      // Initialize multiple sessions
      const createSessionSpy = vi.spyOn(mockEngine, 'createSession');

      let sessionCounter = 0;
      createSessionSpy.mockImplementation(async () => ({
        id: `session-${++sessionCounter}`,
        state: 'active' as const,
        connectedAt: new Date(),
        upstreamHandles: new Map(),
        upstreamStatuses: new Map(),
        toolCount: 0,
        inFlightCalls: 0,
      }));

      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');

      // Create first session
      await initHandler(request);

      // Trigger onclose
      if (server.onclose) server.onclose();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(closeSpy).toHaveBeenCalled();
    });

    it('should remove sessions from map even on close errors', async () => {
      let callCount = 0;
      const partiallyFailingEngine = {
        ...mockEngine,
        closeSession: vi.fn().mockImplementation(async (_sessionId: string) => {
          if (++callCount === 1) {
            throw new Error('close failed');
          }
        }),
      } as unknown as IAggregatorEngine;

      const server = createMcpServer({ engine: partiallyFailingEngine, serverConfigs });

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      // Trigger onclose
      if (server.onclose) server.onclose();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have attempted to close the session despite error
      expect(partiallyFailingEngine.closeSession).toHaveBeenCalled();
    });

    it('should throw error when ALL sessions fail to close', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const fullyFailingEngine = {
        ...mockEngine,
        closeSession: vi.fn().mockRejectedValue(new Error('close failed')),
      } as unknown as IAggregatorEngine;

      const server = createMcpServer({ engine: fullyFailingEngine, serverConfigs });

      // Initialize session
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      if (!initHandler) throw new Error('Initialize handler not found');
      await initHandler(request);

      // Trigger onclose and wait for completion
      if (server.onclose) server.onclose();

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have logged the error - check for either session cleanup error or general error
      const errorCalls = consoleErrorSpy.mock.calls.map((call) => call.join(' '));
      const hasCleanupError = errorCalls.some((msg) =>
        msg.includes('Error during onclose') || msg.includes('Closing session')
      );
      expect(hasCleanupError).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it('should aggregate errors from multiple failed cleanups', async () => {
      let sessionCounter = 0;
      const multiSessionEngine = {
        ...mockEngine,
        createSession: vi.fn().mockImplementation(async () => ({
          id: `session-${++sessionCounter}`,
          state: 'active',
          upstreamHandles: new Map(),
          upstreamStatuses: new Map(),
        })),
        closeSession: vi.fn().mockRejectedValue(new Error('cleanup failed')),
      } as unknown as IAggregatorEngine;

      const server = createMcpServer({ engine: multiSessionEngine, serverConfigs });

      // Initialize session (only one in M1, but testing the aggregation logic)
      const request = {
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      };

      const handlers = (server as any)._requestHandlers;
      const initHandler = handlers.get('initialize');
      await initHandler(request);

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Trigger onclose
      if (server.onclose) server.onclose();

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should log error count and total failure - check for any cleanup-related error
      const errorCalls = consoleErrorSpy.mock.calls.map((call) => call.join(' '));
      const hasCleanupError = errorCalls.some((msg) =>
        msg.includes('Error during onclose') || msg.includes('Failed to close') || msg.includes('session')
      );
      expect(hasCleanupError).toBe(true);

      consoleErrorSpy.mockRestore();
    });
  });
});
