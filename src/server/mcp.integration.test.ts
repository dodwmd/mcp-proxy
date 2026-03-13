import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AggregatorEngine } from '../aggregator/engine.js';
import type { ResolvedServerConfig } from '../config/types.js';
import type { IUpstreamHandle } from '../upstream/types.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';

/**
 * Integration tests for M1 Milestone: Core proxy with basic MCP aggregation
 *
 * These tests verify:
 * - End-to-end flow from config → upstream connect → aggregator → tool routing
 * - Multi-server tool aggregation with proper namespacing (server__toolname)
 * - Tool call routing to correct upstream based on namespace
 * - Error handling for invalid tool names and connection failures
 * - Session lifecycle and state management
 */
describe('MCP Aggregator Integration (M1)', () => {
  let engine: AggregatorEngine;
  let mockUpstreams: Map<string, MockUpstreamHandle>;
  let serverConfigs: ResolvedServerConfig[];
  let sessionId: string | null = null;

  beforeEach(() => {
    // Create mock upstream servers
    mockUpstreams = new Map([
      [
        'weather',
        new MockUpstreamHandle('weather', [
          { name: 'get_forecast', description: 'Get weather forecast', inputSchema: {} },
          { name: 'get_current', description: 'Get current weather', inputSchema: {} },
        ]),
      ],
      [
        'database',
        new MockUpstreamHandle('database', [
          { name: 'query', description: 'Execute database query', inputSchema: {} },
          { name: 'insert', description: 'Insert data', inputSchema: {} },
        ]),
      ],
    ]);

    // Create server configs
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

    // Create engine with mocked connection manager
    engine = new MockAggregatorEngine(mockUpstreams);
  });

  afterEach(async () => {
    // Clean up session if created
    if (sessionId) {
      await engine.closeSession(sessionId);
      sessionId = null;
    }
  });

  describe('Session Initialization', () => {
    it('should create session and connect to all upstream servers', async () => {
      const session = await engine.createSession({
        sessionId: 'test-session-1',
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
        serverConfigs,
      });

      expect(session).toBeDefined();
      expect(session.id).toBe('test-session-1');
      expect(session.state).toBe('active');
      expect(session.upstreamHandles.size).toBe(2);
      expect(session.upstreamHandles.has('weather')).toBe(true);
      expect(session.upstreamHandles.has('database')).toBe(true);
      expect(session.upstreamStatuses.get('weather')).toBe('connected');
      expect(session.upstreamStatuses.get('database')).toBe('connected');

      sessionId = session.id;
    });

    it('should track session metadata correctly', async () => {
      const session = await engine.createSession({
        sessionId: 'test-session-2',
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
        serverConfigs,
      });

      expect(session.connectedAt).toBeInstanceOf(Date);
      expect(session.inFlightCalls).toBe(0);
      expect(session.toolCount).toBe(0); // Not yet populated

      sessionId = session.id;
    });

    it('should handle partial connection failures gracefully', async () => {
      // Add a failing upstream
      serverConfigs.push({
        id: 'failing-1',
        alias: 'failing',
        name: 'Failing Server',
        transport: 'stdio',
        enabled: true,
        timeoutMs: 5000,
        command: 'failing-server',
      });

      const session = await engine.createSession({
        sessionId: 'test-session-3',
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
        serverConfigs,
      });

      // Should still succeed with partial connections
      expect(session).toBeDefined();
      expect(session.upstreamHandles.size).toBe(2); // Only successful connections
      expect(session.upstreamStatuses.get('failing')).toBe('error');
      expect(session.upstreamStatuses.get('weather')).toBe('connected');

      sessionId = session.id;
    });
  });

  describe('Tool Aggregation (tools/list)', () => {
    beforeEach(async () => {
      // Initialize session before each test
      const session = await engine.createSession({
        sessionId: 'test-session-list',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;
    });

    it('should return aggregated tool list from all upstreams', async () => {
      const tools = await engine.listTools(sessionId!);

      expect(tools).toBeDefined();
      expect(tools.length).toBe(4); // 2 from weather + 2 from database
    });

    it('should namespace tools with server__toolname format', async () => {
      const tools = await engine.listTools(sessionId!);
      const toolNames = tools.map((t) => t.name);

      // Verify all tools are namespaced correctly
      expect(toolNames).toContain('weather__get_forecast');
      expect(toolNames).toContain('weather__get_current');
      expect(toolNames).toContain('database__query');
      expect(toolNames).toContain('database__insert');

      // Verify no unnamespaced tools
      expect(toolNames).not.toContain('get_forecast');
      expect(toolNames).not.toContain('query');
    });

    it('should preserve tool descriptions and schemas', async () => {
      const tools = await engine.listTools(sessionId!);

      const forecastTool = tools.find((t) => t.name === 'weather__get_forecast');
      expect(forecastTool).toBeDefined();
      expect(forecastTool!.description).toBe('Get weather forecast');
      expect(forecastTool!.inputSchema).toEqual({});
    });

    it('should handle upstreams with no tools', async () => {
      // Add an upstream with no tools
      mockUpstreams.set('empty', new MockUpstreamHandle('empty', []));

      const tools = await engine.listTools(sessionId!);

      // Should still return tools from other upstreams
      expect(tools.length).toBe(4);
    });

    it('should update session tool count after listing', async () => {
      await engine.listTools(sessionId!);

      const session = engine.getSession(sessionId!);
      expect(session!.toolCount).toBe(4);
    });

    it('should throw error when session not found', async () => {
      await expect(engine.listTools('nonexistent-session')).rejects.toThrow('Session not found');
    });

    it('should throw error when session is closed', async () => {
      await engine.closeSession(sessionId!);

      await expect(engine.listTools(sessionId!)).rejects.toThrow('Session not found');
      sessionId = null;
    });
  });

  describe('Tool Routing (tools/call)', () => {
    beforeEach(async () => {
      // Initialize session before each test
      const session = await engine.createSession({
        sessionId: 'test-session-call',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;
    });

    it('should route tool call to correct upstream based on namespace', async () => {
      const result = await engine.callTool(sessionId!, 'weather__get_forecast', {
        city: 'San Francisco',
      });

      expect(result).toBeDefined();

      // Verify the call was routed to weather upstream
      const weatherUpstream = mockUpstreams.get('weather')!;
      expect(weatherUpstream.callCount).toBe(1);
      expect(weatherUpstream.lastCall).toEqual({
        name: 'get_forecast',
        args: { city: 'San Francisco' },
      });
    });

    it('should strip namespace prefix when calling upstream', async () => {
      await engine.callTool(sessionId!, 'database__query', { sql: 'SELECT * FROM users' });

      // Verify upstream received original tool name without namespace
      const dbUpstream = mockUpstreams.get('database')!;
      expect(dbUpstream.lastCall!.name).toBe('query');
      expect(dbUpstream.lastCall!.name).not.toContain('database__');
    });

    it('should handle tool calls with no arguments', async () => {
      await engine.callTool(sessionId!, 'weather__get_current', {});

      const weatherUpstream = mockUpstreams.get('weather')!;
      expect(weatherUpstream.lastCall!.args).toEqual({});
    });

    it('should return upstream response', async () => {
      const weatherUpstream = mockUpstreams.get('weather')!;
      weatherUpstream.mockResult = { temperature: 72, condition: 'sunny' };

      const result = await engine.callTool(sessionId!, 'weather__get_forecast', {});

      expect(result).toEqual({ temperature: 72, condition: 'sunny' });
    });

    it('should track in-flight calls during execution', async () => {
      let inFlightDuringCall = 0;
      const weatherUpstream = mockUpstreams.get('weather')!;
      weatherUpstream.onCallStart = () => {
        const session = engine.getSession(sessionId!);
        inFlightDuringCall = session!.inFlightCalls;
      };

      await engine.callTool(sessionId!, 'weather__get_forecast', {});

      expect(inFlightDuringCall).toBe(1);

      // After call, should be back to 0
      const session = engine.getSession(sessionId!);
      expect(session!.inFlightCalls).toBe(0);
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      // Initialize session before each test
      const session = await engine.createSession({
        sessionId: 'test-session-errors',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;
    });

    it('should reject invalid tool name format', async () => {
      await expect(
        engine.callTool(sessionId!, 'invalid-format-no-double-underscore', {})
      ).rejects.toThrow('Invalid namespaced tool name format');
    });

    it('should reject tool call to non-existent upstream', async () => {
      await expect(engine.callTool(sessionId!, 'nonexistent__some_tool', {})).rejects.toThrow(
        'Upstream not found or not connected'
      );
    });

    it('should reject tool call without active session', async () => {
      await expect(engine.callTool('nonexistent-session', 'weather__get_forecast', {})).rejects.toThrow(
        'Session not found'
      );
    });

    it('should reject tool call on closed session', async () => {
      await engine.closeSession(sessionId!);

      await expect(engine.callTool(sessionId!, 'weather__get_forecast', {})).rejects.toThrow(
        'Session not found'
      );
      sessionId = null;
    });

    it('should propagate upstream errors with proper error message', async () => {
      const weatherUpstream = mockUpstreams.get('weather')!;
      weatherUpstream.mockError = new Error('Upstream service unavailable');

      await expect(engine.callTool(sessionId!, 'weather__get_forecast', {})).rejects.toThrow(
        'Upstream service unavailable'
      );
    });

    it('should decrement in-flight calls even on error', async () => {
      const weatherUpstream = mockUpstreams.get('weather')!;
      weatherUpstream.mockError = new Error('Test error');

      await expect(engine.callTool(sessionId!, 'weather__get_forecast', {})).rejects.toThrow('Test error');

      const session = engine.getSession(sessionId!);
      expect(session!.inFlightCalls).toBe(0);
    });
  });

  describe('Multi-Server Aggregation', () => {
    it('should aggregate tools from multiple servers without conflicts', async () => {
      // Add third server with overlapping tool names
      mockUpstreams.set(
        'weather-backup',
        new MockUpstreamHandle('weather-backup', [
          { name: 'get_forecast', description: 'Backup forecast', inputSchema: {} },
        ])
      );

      // Add backup server to config
      const multiServerConfigs = [
        ...serverConfigs,
        {
          id: 'weather-backup-1',
          alias: 'weather-backup',
          name: 'Weather Backup Server',
          transport: 'stdio' as const,
          enabled: true,
          timeoutMs: 5000,
          command: 'mock-weather-backup-server',
        },
      ];

      // Create new session with all servers
      const session = await engine.createSession({
        sessionId: 'test-session-multi-aggregate',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs: multiServerConfigs,
      });
      sessionId = session.id;

      const tools = await engine.listTools(sessionId!);
      const toolNames = tools.map((t) => t.name);

      // Should have both weather__get_forecast and weather-backup__get_forecast
      expect(toolNames).toContain('weather__get_forecast');
      expect(toolNames).toContain('weather-backup__get_forecast');
      expect(tools.length).toBe(5); // 2 weather + 2 database + 1 weather-backup
    });

    it('should route tool calls to correct server when multiple have same base name', async () => {
      // Add backup server
      mockUpstreams.set(
        'weather-backup',
        new MockUpstreamHandle('weather-backup', [
          { name: 'get_forecast', description: 'Backup forecast', inputSchema: {} },
        ])
      );

      // Add backup server to config
      const multiServerConfigs = [
        ...serverConfigs,
        {
          id: 'weather-backup-1',
          alias: 'weather-backup',
          name: 'Weather Backup Server',
          transport: 'stdio' as const,
          enabled: true,
          timeoutMs: 5000,
          command: 'mock-weather-backup-server',
        },
      ];

      // Create new session with all servers
      const session = await engine.createSession({
        sessionId: 'test-session-multi-route',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs: multiServerConfigs,
      });
      sessionId = session.id;

      // Call the backup server
      await engine.callTool(sessionId!, 'weather-backup__get_forecast', { city: 'New York' });

      // Verify only backup server was called
      const backupUpstream = mockUpstreams.get('weather-backup')!;
      const primaryUpstream = mockUpstreams.get('weather')!;

      expect(backupUpstream.callCount).toBe(1);
      expect(primaryUpstream.callCount).toBe(0);
    });

    it('should handle concurrent tool calls to different upstreams', async () => {
      // Create a dedicated session for this test
      const session = await engine.createSession({
        sessionId: 'test-session-concurrent-diff',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;

      // Reset call counts
      mockUpstreams.get('weather')!.callCount = 0;
      mockUpstreams.get('database')!.callCount = 0;

      // Make concurrent calls to different upstreams
      const [result1, result2] = await Promise.all([
        engine.callTool(sessionId!, 'weather__get_forecast', {}),
        engine.callTool(sessionId!, 'database__query', {}),
      ]);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      // Verify both upstreams were called
      expect(mockUpstreams.get('weather')!.callCount).toBe(1);
      expect(mockUpstreams.get('database')!.callCount).toBe(1);
    });

    it('should handle concurrent tool calls to same upstream', async () => {
      // Create a dedicated session for this test
      const session = await engine.createSession({
        sessionId: 'test-session-concurrent-same',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;

      // Reset call count
      const weatherUpstream = mockUpstreams.get('weather')!;
      weatherUpstream.callCount = 0;

      // Make concurrent calls to same upstream
      const [result1, result2] = await Promise.all([
        engine.callTool(sessionId!, 'weather__get_forecast', { city: 'SF' }),
        engine.callTool(sessionId!, 'weather__get_current', { city: 'NY' }),
      ]);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      expect(weatherUpstream.callCount).toBe(2);
    });
  });

  describe('Session Lifecycle', () => {
    it('should track session state correctly', async () => {
      const session = await engine.createSession({
        sessionId: 'test-session-lifecycle',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;

      expect(session).toBeDefined();
      expect(session.state).toBe('active');
      expect(session.connectedAt).toBeInstanceOf(Date);

      // Tool count is 0 until first listTools call
      expect(session.toolCount).toBe(0);
      await engine.listTools(sessionId!);

      const updatedSession = engine.getSession(sessionId!);
      expect(updatedSession!.toolCount).toBe(4);
    });

    it('should allow retrieving existing session', async () => {
      const session = await engine.createSession({
        sessionId: 'test-session-retrieve',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;

      const retrievedSession = engine.getSession(sessionId!);
      expect(retrievedSession).toBeDefined();
      expect(retrievedSession!.id).toBe(sessionId);
      expect(retrievedSession!.state).toBe('active');
    });

    it('should return undefined for non-existent session', () => {
      const session = engine.getSession('nonexistent-session');
      expect(session).toBeUndefined();
    });

    it('should clean up upstreams when closing session', async () => {
      const session = await engine.createSession({
        sessionId: 'test-session-cleanup',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;

      // Track initial closed state
      const weatherUpstream = mockUpstreams.get('weather')!;
      const dbUpstream = mockUpstreams.get('database')!;
      expect(weatherUpstream.closed).toBe(false);
      expect(dbUpstream.closed).toBe(false);

      await engine.closeSession(sessionId!);

      // Verify all upstreams were closed
      expect(weatherUpstream.closed).toBe(true);
      expect(dbUpstream.closed).toBe(true);

      // Session should no longer exist
      expect(engine.getSession(sessionId!)).toBeUndefined();
      sessionId = null;
    });

    it('should handle closing non-existent session gracefully', async () => {
      // Should not throw
      await expect(engine.closeSession('nonexistent-session')).resolves.toBeUndefined();
    });

    it('should prevent operations on closed session', async () => {
      const session = await engine.createSession({
        sessionId: 'test-session-closed',
        clientInfo: { name: 'test-client', version: '1.0.0' },
        serverConfigs,
      });
      sessionId = session.id;

      await engine.closeSession(sessionId!);

      // All operations should fail
      await expect(engine.listTools(sessionId!)).rejects.toThrow('Session not found');
      await expect(engine.callTool(sessionId!, 'weather__get_forecast', {})).rejects.toThrow(
        'Session not found'
      );

      sessionId = null;
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
  public onCallStart?: () => void;

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  async readResource(uri: string): Promise<unknown> {
    return { contents: [] };
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown> {
    return { messages: [] };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      throw new Error('Upstream is closed');
    }

    this.onCallStart?.();
    this.callCount++;
    this.lastCall = { name, args };

    if (this.mockError) {
      throw this.mockError;
    }

    return this.mockResult;
  }
}

/**
 * Mock aggregator engine that uses mock upstreams instead of real connections
 */
class MockAggregatorEngine extends AggregatorEngine {
  private mockUpstreams: Map<string, MockUpstreamHandle>;

  constructor(mockUpstreams: Map<string, MockUpstreamHandle>) {
    super();
    this.mockUpstreams = mockUpstreams;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async createSession(params: any): Promise<any> {
    const { sessionId, serverConfigs } = params;

    // Create mock connections based on configured servers
    const upstreamHandles = new Map<string, IUpstreamHandle>();
    const upstreamStatuses = new Map<string, 'connected' | 'error' | 'skipped'>();

    for (const config of serverConfigs) {
      const mockUpstream = this.mockUpstreams.get(config.alias);
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
