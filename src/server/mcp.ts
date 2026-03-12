import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  InitializeRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
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
        resources: {},
        prompts: {},
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

  // Handle resources/list
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const sessionEntry = Array.from(activeSessions.values())[0];
    if (!sessionEntry) {
      throw new Error('No active session found');
    }

    const { sessionId } = sessionEntry;
    console.log(`[${sessionId}] Listing resources`);

    try {
      const resources = await engine.listResources(sessionId);
      console.log(`[${sessionId}] Returning ${resources.length} resources`);

      return {
        resources,
      };
    } catch (error) {
      console.error(`[${sessionId}] Failed to list resources:`, error);
      throw new Error(`Failed to list resources: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Handle resources/read
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    const sessionEntry = Array.from(activeSessions.values())[0];
    if (!sessionEntry) {
      throw new Error('No active session found');
    }

    const { sessionId } = sessionEntry;
    console.log(`[${sessionId}] Reading resource: ${uri}`);

    try {
      const result = await engine.readResource(sessionId, uri);
      console.log(`[${sessionId}] Resource read successful: ${uri}`);

      // Return result as-is from upstream (SDK types it properly)
      return result as any;
    } catch (error) {
      console.error(`[${sessionId}] Resource read failed: ${uri}`, error);
      throw new Error(`Resource read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Handle prompts/list
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const sessionEntry = Array.from(activeSessions.values())[0];
    if (!sessionEntry) {
      throw new Error('No active session found');
    }

    const { sessionId } = sessionEntry;
    console.log(`[${sessionId}] Listing prompts`);

    try {
      const prompts = await engine.listPrompts(sessionId);
      console.log(`[${sessionId}] Returning ${prompts.length} prompts`);

      return {
        prompts,
      };
    } catch (error) {
      console.error(`[${sessionId}] Failed to list prompts:`, error);
      throw new Error(`Failed to list prompts: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // Handle prompts/get
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const sessionEntry = Array.from(activeSessions.values())[0];
    if (!sessionEntry) {
      throw new Error('No active session found');
    }

    const { sessionId } = sessionEntry;
    console.log(`[${sessionId}] Getting prompt: ${name}`);

    try {
      const result = await engine.getPrompt(sessionId, name, args as Record<string, unknown> | undefined);
      console.log(`[${sessionId}] Prompt retrieval successful: ${name}`);

      // Return result as-is from upstream (SDK types it properly)
      return result as any;
    } catch (error) {
      console.error(`[${sessionId}] Prompt retrieval failed: ${name}`, error);
      throw new Error(`Prompt retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
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
