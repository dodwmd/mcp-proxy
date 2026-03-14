import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  InitializeRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { IAggregatorEngine, CreateSessionParams } from '../aggregator/types.js';
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
  const activeSessions = new Map<string, { sessionId: string; clientInfo: CreateSessionParams['clientInfo'] }>();

  const server = new Server(serverInfo, {
    capabilities: {
      tools: {},
    },
  });

  // Handle initialization
  server.setRequestHandler(InitializeRequestSchema, async (request, extra) => {
    // Use transport-provided sessionId if available, otherwise generate one
    // This ensures consistency with the transport layer
    const sessionId = extra.sessionId ?? randomUUID();
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
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    // Get session ID from transport context provided by the SDK
    const sessionId = extra.sessionId;
    if (!sessionId || !activeSessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId ?? 'undefined'}`);
    }

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
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;

    // Get session ID from transport context provided by the SDK
    const sessionId = extra.sessionId;
    if (!sessionId || !activeSessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId ?? 'undefined'}`);
    }

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

  // Handle connection close
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
