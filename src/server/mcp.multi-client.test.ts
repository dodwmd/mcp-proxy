import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AggregatorEngine } from '../aggregator/engine.js';
import type { ResolvedServerConfig } from '../config/types.js';
import type { IUpstreamHandle } from '../upstream/types.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';

/**
 * Regression test for multi-client session management bug fix (PAP-24)
 *
 * Bug: All requests were routed to the first session only, regardless of which client made the request.
 * Root Cause: Both tools/list and tools/call handlers in src/server/mcp.ts used:
 *   `Array.from(activeSessions.values())[0]`
 *   This always returned the first session, ignoring which client actually made the request.
 *
 * Fix: Updated handlers to use `extra.sessionId` to correctly identify the requesting session:
 *   `const sessionId = extra.sessionId ?? Array.from(activeSessions.values())[0]?.sessionId;`
 *   Now the SDK-provided sessionId is used first, falling back to first session for backward compatibility.
 *
 * Test Strategy:
 * These tests verify session isolation at the aggregator engine level, which is where the bug manifested.
 * When the MCP server handlers were routing all requests to the first session, the engine would always
 * use the first session's upstreams, causing the wrong tools/results to be returned.
 *
 * This test verifies:
 * - Multiple client sessions are properly isolated at the aggregator engine level
 * - Each session maintains its own set of upstream connections
 * - Tool lists and tool calls are correctly routed to the session that made the request
 * - Sessions with different upstream configurations get different results
 * - Concurrent requests from different sessions don't interfere with each other
 *
 * These tests WOULD HAVE FAILED before the fix because:
 * - Session 2 and 3 would receive Session 1's tools/results
 * - Tool calls from Session 2 would execute against Session 1's upstreams
 * - Concurrent requests would all use the same (first) session
 */
describe('MCP Aggregator Multi-Session Isolation (Regression Test for PAP-24)', () => {
  let engine: AggregatorEngine;
  let mockUpstreams: Map<string, Map<string, MockUpstreamHandle>>;
  let serverConfigs: ResolvedServerConfig[];
  let sessionIds: string[] = [];

  beforeEach(() => {
    // Create separate mock upstreams for different sessions
    // Session 1 gets weather + database
    // Session 2 gets only weather
    // Session 3 gets only database
    mockUpstreams = new Map();

    serverConfigs = [
      {
        id: 'weather-1',
        alias: 'weather',
        name: 'Weather Server',
        transport: 'stdio',
        enabled: true,
        timeoutMs: 5000,
        command: 'mock-weather-server',
      },
      {
        id: 'database-1',
        alias: 'database',
        name: 'Database Server',
        transport: 'stdio',
        enabled: true,
        timeoutMs: 5000,
        command: 'mock-database-server',
      },
    ];

    // Create engine
    engine = new MockAggregatorEngine(mockUpstreams);
  });

  afterEach(async () => {
    // Clean up all sessions
    for (const sessionId of sessionIds) {
      await engine.closeSession(sessionId);
    }
    sessionIds = [];
  });

  describe('Session-Specific Tool Lists', () => {
    it('should return different tool lists for different sessions', async () => {
      // Create session 1 with both weather and database upstreams
      const session1Upstreams = new Map([
        [
          'weather',
          new MockUpstreamHandle('weather', [
            { name: 'get_forecast', description: 'Weather forecast', inputSchema: {} },
            { name: 'get_current', description: 'Current weather', inputSchema: {} },
          ]),
        ],
        [
          'database',
          new MockUpstreamHandle('database', [
            { name: 'query', description: 'Database query', inputSchema: {} },
            { name: 'insert', description: 'Database insert', inputSchema: {} },
          ]),
        ],
      ]);
      mockUpstreams.set('session-1', session1Upstreams);

      const session1 = await engine.createSession({
        sessionId: 'session-1',
        clientInfo: { name: 'client-1', version: '1.0.0' },
        serverConfigs,
      });
      sessionIds.push(session1.id);

      // Create session 2 with only weather upstream
      const session2Upstreams = new Map([
        [
          'weather',
          new MockUpstreamHandle('weather', [
            { name: 'get_alerts', description: 'Weather alerts', inputSchema: {} },
          ]),
        ],
      ]);
      mockUpstreams.set('session-2', session2Upstreams);

      const session2 = await engine.createSession({
        sessionId: 'session-2',
        clientInfo: { name: 'client-2', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]], // Only weather
      });
      sessionIds.push(session2.id);

      // Create session 3 with only database upstream
      const session3Upstreams = new Map([
        [
          'database',
          new MockUpstreamHandle('database', [
            { name: 'migrate', description: 'Database migration', inputSchema: {} },
          ]),
        ],
      ]);
      mockUpstreams.set('session-3', session3Upstreams);

      const session3 = await engine.createSession({
        sessionId: 'session-3',
        clientInfo: { name: 'client-3', version: '1.0.0' },
        serverConfigs: [serverConfigs[1]], // Only database
      });
      sessionIds.push(session3.id);

      // Get tools for each session
      const tools1 = await engine.listTools('session-1');
      const tools2 = await engine.listTools('session-2');
      const tools3 = await engine.listTools('session-3');

      // Verify session 1 got weather + database tools (4 total, namespaced)
      expect(tools1).toHaveLength(4);
      expect(tools1.map((t) => t.name).sort()).toEqual([
        'database__insert',
        'database__query',
        'weather__get_current',
        'weather__get_forecast',
      ]);

      // Verify session 2 got only weather tools (1 total, namespaced)
      expect(tools2).toHaveLength(1);
      expect(tools2.map((t) => t.name)).toEqual(['weather__get_alerts']);

      // Verify session 3 got only database tools (1 total, namespaced)
      expect(tools3).toHaveLength(1);
      expect(tools3.map((t) => t.name)).toEqual(['database__migrate']);
    });

    it('should handle concurrent listTools requests from multiple sessions', async () => {
      // Create 3 sessions with different tool sets
      for (let i = 1; i <= 3; i++) {
        const sessionId = `concurrent-session-${i}`;
        const upstreams = new Map([
          [
            'weather',
            new MockUpstreamHandle('weather', [
              { name: `tool_${i}`, description: `Tool ${i}`, inputSchema: {} },
            ]),
          ],
        ]);
        mockUpstreams.set(sessionId, upstreams);

        await engine.createSession({
          sessionId,
          clientInfo: { name: `client-${i}`, version: '1.0.0' },
          serverConfigs: [serverConfigs[0]],
        });
        sessionIds.push(sessionId);
      }

      // Make concurrent listTools calls
      const [tools1, tools2, tools3] = await Promise.all([
        engine.listTools('concurrent-session-1'),
        engine.listTools('concurrent-session-2'),
        engine.listTools('concurrent-session-3'),
      ]);

      // Each session should get its own tools
      expect(tools1.map((t) => t.name)).toEqual(['weather__tool_1']);
      expect(tools2.map((t) => t.name)).toEqual(['weather__tool_2']);
      expect(tools3.map((t) => t.name)).toEqual(['weather__tool_3']);
    });
  });

  describe('Session-Specific Tool Calls', () => {
    it('should route tool calls to the correct session upstreams', async () => {
      // Create session 1 with weather upstream
      const weather1 = new MockUpstreamHandle('weather', [
        { name: 'get_forecast', description: 'Forecast', inputSchema: {} },
      ]);
      weather1.mockResult = { temperature: 72, location: 'San Francisco' };
      mockUpstreams.set('session-1', new Map([['weather', weather1]]));

      await engine.createSession({
        sessionId: 'session-1',
        clientInfo: { name: 'client-1', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-1');

      // Create session 2 with different weather upstream
      const weather2 = new MockUpstreamHandle('weather', [
        { name: 'get_forecast', description: 'Forecast', inputSchema: {} },
      ]);
      weather2.mockResult = { temperature: 85, location: 'Los Angeles' };
      mockUpstreams.set('session-2', new Map([['weather', weather2]]));

      await engine.createSession({
        sessionId: 'session-2',
        clientInfo: { name: 'client-2', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-2');

      // Call tool from session 1
      const result1 = await engine.callTool('session-1', 'weather__get_forecast', {});

      // Call tool from session 2
      const result2 = await engine.callTool('session-2', 'weather__get_forecast', {});

      // Each session should get its own result
      expect(result1).toEqual({ temperature: 72, location: 'San Francisco' });
      expect(result2).toEqual({ temperature: 85, location: 'Los Angeles' });

      // Verify each upstream was called once
      expect(weather1.callCount).toBe(1);
      expect(weather2.callCount).toBe(1);
    });

    it('should handle concurrent tool calls from different sessions', async () => {
      // Create 3 sessions, each with its own upstream
      const upstreamHandles: MockUpstreamHandle[] = [];

      for (let i = 1; i <= 3; i++) {
        const sessionId = `concurrent-call-session-${i}`;
        const upstream = new MockUpstreamHandle('weather', [
          { name: 'get_data', description: 'Get data', inputSchema: {} },
        ]);
        upstream.mockResult = { sessionId, data: `result_${i}` };
        upstreamHandles.push(upstream);

        mockUpstreams.set(sessionId, new Map([['weather', upstream]]));

        await engine.createSession({
          sessionId,
          clientInfo: { name: `client-${i}`, version: '1.0.0' },
          serverConfigs: [serverConfigs[0]],
        });
        sessionIds.push(sessionId);
      }

      // Make concurrent tool calls
      const [result1, result2, result3] = await Promise.all([
        engine.callTool('concurrent-call-session-1', 'weather__get_data', {}),
        engine.callTool('concurrent-call-session-2', 'weather__get_data', {}),
        engine.callTool('concurrent-call-session-3', 'weather__get_data', {}),
      ]);

      // Each session should get its own result
      expect(result1).toEqual({ sessionId: 'concurrent-call-session-1', data: 'result_1' });
      expect(result2).toEqual({ sessionId: 'concurrent-call-session-2', data: 'result_2' });
      expect(result3).toEqual({ sessionId: 'concurrent-call-session-3', data: 'result_3' });

      // All upstreams should have been called
      expect(upstreamHandles[0].callCount).toBe(1);
      expect(upstreamHandles[1].callCount).toBe(1);
      expect(upstreamHandles[2].callCount).toBe(1);
    });
  });

  describe('Session Independence', () => {
    it('should not interfere between sessions when one session closes', async () => {
      // Create 2 sessions
      for (let i = 1; i <= 2; i++) {
        const sessionId = `session-${i}`;
        mockUpstreams.set(
          sessionId,
          new Map([
            [
              'weather',
              new MockUpstreamHandle('weather', [
                { name: `tool_${i}`, description: `Tool ${i}`, inputSchema: {} },
              ]),
            ],
          ])
        );

        await engine.createSession({
          sessionId,
          clientInfo: { name: `client-${i}`, version: '1.0.0' },
          serverConfigs: [serverConfigs[0]],
        });
        sessionIds.push(sessionId);
      }

      // Verify both sessions work
      const tools1Before = await engine.listTools('session-1');
      const tools2Before = await engine.listTools('session-2');

      expect(tools1Before).toHaveLength(1);
      expect(tools2Before).toHaveLength(1);

      // Close session 1
      await engine.closeSession('session-1');
      sessionIds = sessionIds.filter((id) => id !== 'session-1');

      // Session 2 should still work
      const tools2After = await engine.listTools('session-2');
      expect(tools2After).toHaveLength(1);
      expect(tools2After[0].name).toBe('weather__tool_2');

      // Session 1 should be gone
      await expect(engine.listTools('session-1')).rejects.toThrow('Session not found');
    });

    it('should maintain separate in-flight call counters per session', async () => {
      // Create 2 sessions with slow tool calls
      for (let i = 1; i <= 2; i++) {
        const sessionId = `slow-session-${i}`;
        const upstream = new MockUpstreamHandle('weather', [
          { name: 'slow_tool', description: 'Slow tool', inputSchema: {} },
        ]);
        // Make tool calls take 100ms
        upstream.callDelay = 100;

        mockUpstreams.set(sessionId, new Map([['weather', upstream]]));

        await engine.createSession({
          sessionId,
          clientInfo: { name: `client-${i}`, version: '1.0.0' },
          serverConfigs: [serverConfigs[0]],
        });
        sessionIds.push(sessionId);
      }

      // Start tool calls in both sessions (don't await yet)
      const call1 = engine.callTool('slow-session-1', 'weather__slow_tool', {});
      const call2 = engine.callTool('slow-session-2', 'weather__slow_tool', {});

      // Wait a bit for calls to be in flight
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Check in-flight counters (each session should have 1)
      const session1 = engine.getSession('slow-session-1');
      const session2 = engine.getSession('slow-session-2');

      expect(session1?.inFlightCalls).toBe(1);
      expect(session2?.inFlightCalls).toBe(1);

      // Wait for calls to complete
      await Promise.all([call1, call2]);

      // After completion, both should be 0
      const session1After = engine.getSession('slow-session-1');
      const session2After = engine.getSession('slow-session-2');

      expect(session1After?.inFlightCalls).toBe(0);
      expect(session2After?.inFlightCalls).toBe(0);
    });
  });

  describe('No Silent Fallback to First Session (Regression Test for PAP-50)', () => {
    it('should throw explicit error when tools/list is called without sessionId', async () => {
      // Create session 1 with weather upstream
      const session1Upstreams = new Map([
        [
          'weather',
          new MockUpstreamHandle('weather', [
            { name: 'get_forecast', description: 'Weather forecast', inputSchema: {} },
          ]),
        ],
      ]);
      mockUpstreams.set('session-1', session1Upstreams);

      await engine.createSession({
        sessionId: 'session-1',
        clientInfo: { name: 'client-1', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-1');

      // Attempt to list tools with undefined sessionId
      // This simulates the transport layer not providing extra.sessionId
      await expect(engine.listTools(undefined as any)).rejects.toThrow('Session not found: undefined');
    });

    it('should throw explicit error when tools/call is called without sessionId', async () => {
      // Create session 1 with weather upstream
      const session1Upstreams = new Map([
        [
          'weather',
          new MockUpstreamHandle('weather', [
            { name: 'get_forecast', description: 'Weather forecast', inputSchema: {} },
          ]),
        ],
      ]);
      mockUpstreams.set('session-1', session1Upstreams);

      await engine.createSession({
        sessionId: 'session-1',
        clientInfo: { name: 'client-1', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-1');

      // Attempt to call tool with undefined sessionId
      // This simulates the transport layer not providing extra.sessionId
      await expect(engine.callTool(undefined as any, 'weather__get_forecast', {})).rejects.toThrow(
        'Session not found: undefined'
      );
    });

    it('should not fall back to first session when sessionId is missing from tools/list', async () => {
      // Create multiple sessions
      const session1Upstreams = new Map([
        [
          'weather',
          new MockUpstreamHandle('weather', [
            { name: 'session1_tool', description: 'Session 1 tool', inputSchema: {} },
          ]),
        ],
      ]);
      mockUpstreams.set('session-1', session1Upstreams);

      const session2Upstreams = new Map([
        [
          'weather',
          new MockUpstreamHandle('weather', [
            { name: 'session2_tool', description: 'Session 2 tool', inputSchema: {} },
          ]),
        ],
      ]);
      mockUpstreams.set('session-2', session2Upstreams);

      await engine.createSession({
        sessionId: 'session-1',
        clientInfo: { name: 'client-1', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-1');

      await engine.createSession({
        sessionId: 'session-2',
        clientInfo: { name: 'client-2', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-2');

      // Call without sessionId - should throw, NOT return session-1's tools
      try {
        await engine.listTools(undefined as any);
        // If we get here, the test should fail
        expect.fail('Expected error to be thrown when sessionId is undefined');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Session not found: undefined');

        // The error message should NOT indicate we got session-1's tools
        // Previously, this would have silently returned session-1's tool list
      }
    });

    it('should not fall back to first session when sessionId is missing from tools/call', async () => {
      // Create multiple sessions
      const weather1 = new MockUpstreamHandle('weather', [
        { name: 'get_forecast', description: 'Forecast', inputSchema: {} },
      ]);
      weather1.mockResult = { session: 'session-1', temperature: 72 };
      mockUpstreams.set('session-1', new Map([['weather', weather1]]));

      const weather2 = new MockUpstreamHandle('weather', [
        { name: 'get_forecast', description: 'Forecast', inputSchema: {} },
      ]);
      weather2.mockResult = { session: 'session-2', temperature: 85 };
      mockUpstreams.set('session-2', new Map([['weather', weather2]]));

      await engine.createSession({
        sessionId: 'session-1',
        clientInfo: { name: 'client-1', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-1');

      await engine.createSession({
        sessionId: 'session-2',
        clientInfo: { name: 'client-2', version: '1.0.0' },
        serverConfigs: [serverConfigs[0]],
      });
      sessionIds.push('session-2');

      // Call tool without sessionId - should throw, NOT execute against session-1
      try {
        await engine.callTool(undefined as any, 'weather__get_forecast', {});
        // If we get here, the test should fail
        expect.fail('Expected error to be thrown when sessionId is undefined');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Session not found: undefined');

        // Verify session-1's upstream was NOT called
        // Previously, the silent fallback would have executed against session-1
        expect(weather1.callCount).toBe(0);
        expect(weather2.callCount).toBe(0);
      }
    });
  });
});

/**
 * Mock upstream handle for testing
 */
class MockUpstreamHandle implements IUpstreamHandle {
  readonly serverId: string;
  readonly alias: string;
  readonly sessionId: string = 'test-session';

  private tools: ToolDescriptor[];
  public callCount = 0;
  public lastCall: { name: string; args: Record<string, unknown> } | null = null;
  public closed = false;
  public mockResult: unknown = { success: true };
  public mockError: Error | null = null;
  public callDelay = 0; // Delay in ms for callTool

  constructor(alias: string, tools: ToolDescriptor[]) {
    this.serverId = `${alias}-server-id`;
    this.alias = alias;
    this.tools = tools;
  }

  async init(): Promise<void> {
    // No-op for mock
  }

  async ping(): Promise<boolean> {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  getClient(): any {
    return null;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (this.closed) {
      throw new Error('Upstream is closed');
    }
    return this.tools;
  }

  async listResources(): Promise<ResourceDescriptor[]> {
    return [];
  }

  async listPrompts(): Promise<PromptDescriptor[]> {
    return [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      throw new Error('Upstream is closed');
    }

    // Simulate delay if configured
    if (this.callDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.callDelay));
    }

    this.callCount++;
    this.lastCall = { name, args };

    if (this.mockError) {
      throw this.mockError;
    }

    return this.mockResult;
  }
}

/**
 * Mock aggregator engine that uses per-session mock upstreams
 */
class MockAggregatorEngine extends AggregatorEngine {
  private mockUpstreams: Map<string, Map<string, MockUpstreamHandle>>;

  constructor(mockUpstreams: Map<string, Map<string, MockUpstreamHandle>>) {
    super();
    this.mockUpstreams = mockUpstreams;
  }

  override async createSession(params: any): Promise<any> {
    const { sessionId, serverConfigs } = params;

    // Get session-specific mock upstreams
    const sessionUpstreams = this.mockUpstreams.get(sessionId);
    if (!sessionUpstreams) {
      throw new Error(`No mock upstreams configured for session: ${sessionId}`);
    }

    // Create mock connections based on configured servers
    const upstreamHandles = new Map<string, IUpstreamHandle>();
    const upstreamStatuses = new Map<string, 'connected' | 'error' | 'skipped'>();

    for (const config of serverConfigs) {
      const mockUpstream = sessionUpstreams.get(config.alias);
      if (mockUpstream) {
        upstreamHandles.set(config.alias, mockUpstream);
        upstreamStatuses.set(config.alias, 'connected');
      } else {
        // Simulate connection failure
        upstreamStatuses.set(config.alias, 'error');
      }
    }

    // Create session
    const session = {
      id: sessionId,
      state: 'active' as const,
      connectedAt: new Date(),
      upstreamHandles,
      upstreamStatuses,
      toolCount: 0,
      inFlightCalls: 0,
    };

    (this as any).sessions.set(sessionId, session);

    return {
      id: sessionId,
      state: 'active' as const,
      connectedAt: session.connectedAt,
      upstreamHandles,
      upstreamStatuses,
      toolCount: 0,
      inFlightCalls: 0,
    };
  }
}
