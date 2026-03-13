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
 * Determines if an MCP error is critical and requires session cleanup.
 * Critical errors include protocol violations and transport failures that
 * indicate the server state is unrecoverable.
 */
function isCriticalMcpError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('protocol_violation') ||
      message.includes('protocol violation') ||
      message.includes('transport_failed') ||
      message.includes('transport failed') ||
      message.includes('connection lost') ||
      message.includes('malformed request')
    );
  }
  return false;
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

  // Guard against concurrent cleanup calls
  let cleanupPromise: Promise<void> | null = null;

  /**
   * Shared cleanup logic for closing all active sessions.
   * Used by both onclose and onerror handlers.
   * Prevents concurrent cleanup by returning the existing promise if cleanup is already in progress.
   */
  const cleanupAllSessions = async (): Promise<void> => {
    // If cleanup is already in progress, return the existing promise
    if (cleanupPromise) return cleanupPromise;

    cleanupPromise = (async () => {
      const sessionIds = Array.from(activeSessions.keys());
      const errors: Array<{ sessionId: string; error: unknown }> = [];

      for (const sessionId of sessionIds) {
        try {
          console.log(`[${sessionId}] Closing session`);
          await engine.closeSession(sessionId);
        } catch (error) {
          console.error(`[${sessionId}] Error closing session:`, error);
          errors.push({ sessionId, error });
        } finally {
          // Always remove from map, even if closeSession fails
          activeSessions.delete(sessionId);
        }
      }

      if (errors.length > 0) {
        console.error(`Failed to close ${errors.length} session(s) during cleanup`);

        // If all sessions failed, throw to signal catastrophic failure
        if (errors.length === sessionIds.length && sessionIds.length > 0) {
          throw new Error(
            `Complete cleanup failure: all ${errors.length} session(s) failed to close`,
            { cause: errors }
          );
        }
      }
    })();

    return cleanupPromise;
  };

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
      throw new Error(
        `Failed to initialize session: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
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
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
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
      throw new Error(
        `Failed to list tools: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
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
      throw new Error(
        `Tool call failed for "${name}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  });

  // Handle connection close - cleanup sessions when MCP server connection closes
  server.onclose = () => {
    console.log('MCP server connection closing, cleaning up sessions...');
    cleanupAllSessions().catch((err) => {
      console.error('FATAL: Session cleanup failed during server close:', err);
      process.exitCode = 1;  // Signal cleanup failure to monitoring
    });
  };

  // Handle errors
  server.onerror = (error) => {
    console.error('MCP server error:', error);

    // Check if this is a critical error that requires session cleanup
    if (isCriticalMcpError(error)) {
      console.error('Critical MCP server error detected, cleaning up sessions...');

      // Clean up sessions asynchronously without blocking error handler
      cleanupAllSessions().catch((err) => {
        console.error('FATAL: Session cleanup failed during critical error handling:', err);
        process.exitCode = 1;  // Signal cleanup failure to monitoring
      });
    }
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
