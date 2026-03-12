import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  InitializeRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { IAggregatorEngine } from '../aggregator/types.js';
import type { ResolvedServerConfig } from '../config/types.js';

export interface McpHandlerOptions {
  engine: IAggregatorEngine;
  serverConfigs: ResolvedServerConfig[];
  serverInfo?: {
    name: string;
    version: string;
  };
}

/**
 * Creates an MCP Server instance configured to aggregate tools from multiple upstream servers.
 *
 * The server handles the MCP protocol lifecycle:
 * - initialize: Creates a session and connects to all configured upstreams
 * - tools/list: Returns aggregated, namespaced tools from all connected upstreams
 * - tools/call: Routes tool calls to the appropriate upstream by parsing the namespaced name
 */
export function createMcpServer(options: McpHandlerOptions): Server {
  const { engine, serverConfigs, serverInfo = { name: 'mcp-aggregator', version: '0.1.0' } } = options;

  // Track active sessions
  const activeSessions = new Map<string, { sessionId: string; clientInfo: unknown }>();

  const server = new Server(serverInfo, {
    capabilities: {
      tools: {},
    },
  });

  // Handle initialization
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const sessionId = randomUUID();
    const clientInfo = request.params.clientInfo;

    console.log(`[${sessionId}] Initializing MCP session for client: ${clientInfo.name}`);

    // Store session info for later reference
    activeSessions.set(sessionId, { sessionId, clientInfo });

    // Create aggregator session and connect to all upstreams
    try {
      await engine.createSession({
        sessionId,
        clientInfo,
        serverConfigs,
      });

      console.log(`[${sessionId}] Session created successfully`);
    } catch (error) {
      console.error(`[${sessionId}] Failed to create session:`, error);
      throw new Error(`Failed to initialize session: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Return standard initialize response
    return {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo,
    };
  });

  // Handle tools/list
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Get session ID from transport context
    // For M1, we use a single implicit session per connection
    // In M2, we'll need to track multiple sessions per agent

    // Find the first active session (for M1, there should only be one)
    const sessionEntry = Array.from(activeSessions.values())[0];
    if (!sessionEntry) {
      throw new Error('No active session found');
    }

    const { sessionId } = sessionEntry;

    console.log(`[${sessionId}] Listing tools`);

    try {
      const tools = await engine.listTools(sessionId);

      console.log(`[${sessionId}] Returning ${tools.length} tools`);

      return {
        tools,
      };
    } catch (error) {
      console.error(`[${sessionId}] Failed to list tools:`, error);
      throw new Error(`Failed to list tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Handle tools/call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Get session ID from transport context
    const sessionEntry = Array.from(activeSessions.values())[0];
    if (!sessionEntry) {
      throw new Error('No active session found');
    }

    const { sessionId } = sessionEntry;

    console.log(`[${sessionId}] Calling tool: ${name}`);

    try {
      const result = await engine.callTool(sessionId, name, args);

      console.log(`[${sessionId}] Tool call successful: ${name}`);

      // Format result according to MCP spec
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error(`[${sessionId}] Tool call failed: ${name}`, error);
      throw new Error(`Tool call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Handle connection close - cleanup sessions when transport closes
  server.onclose = async () => {
    console.log('MCP server connection closing, cleaning up sessions...');

    // Close all active sessions and remove from map
    const sessionIds = Array.from(activeSessions.keys());
    for (const sessionId of sessionIds) {
      try {
        console.log(`[${sessionId}] Closing session`);
        await engine.closeSession(sessionId);
        activeSessions.delete(sessionId);
      } catch (error) {
        console.error(`[${sessionId}] Error closing session:`, error);
      }
    }
  };

  // Handle errors
  server.onerror = async (error) => {
    console.error('MCP server error:', error);
  };

  return server;
}

/**
 * Creates a StreamableHTTP transport for the MCP server.
 * This is used for HTTP-based MCP clients.
 */
export function createStreamableHttpTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
}

/**
 * Creates a stdio transport for the MCP server.
 * This is used for stdio-based MCP clients (e.g., Claude Desktop).
 */
export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
