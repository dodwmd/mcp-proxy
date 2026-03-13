#!/usr/bin/env node

/**
 * mcp-aggregator-stdio — stdio wrapper for Claude Desktop integration
 *
 * This binary acts as a stdio-to-HTTP bridge, allowing Claude Desktop to connect
 * to a running mcp-aggregator server via stdio transport while the aggregator
 * continues to use HTTP.
 *
 * Usage:
 *   mcp-aggregator-stdio --upstream http://localhost:4000 [--agent myagent | --guild myguild]
 *
 * Flags:
 *   --upstream <url>   Required. HTTP URL of the mcp-aggregator server
 *   --agent <name>     Agent identifier (mutually exclusive with --guild)
 *   --guild <name>     Guild identifier (mutually exclusive with --agent)
 *   --timeout <ms>     Request timeout in milliseconds (default: 30000)
 *
 * The wrapper creates an MCP server with stdio transport and proxies all requests
 * to the upstream aggregator via HTTP.
 *
 * Exits with code 1 if the upstream server is unavailable at startup.
 */

import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const program = new Command();

program
  .name('mcp-aggregator-stdio')
  .description('stdio wrapper for Claude Desktop integration with mcp-aggregator')
  .version('0.1.0')
  .requiredOption('--upstream <url>', 'HTTP URL of the mcp-aggregator server')
  .option('--agent <name>', 'Agent identifier')
  .option('--guild <name>', 'Guild identifier')
  .option('--timeout <ms>', 'Request timeout in milliseconds', '30000')
  .action(async (options) => {
    try {
      // Validate mutual exclusion of --agent and --guild
      if (options.agent && options.guild) {
        console.error('Error: --agent and --guild are mutually exclusive');
        process.exit(1);
      }

      const upstreamUrl = options.upstream;
      const timeout = parseInt(options.timeout, 10);

      // Build the upstream endpoint URL (default to /mcp if no agent/guild specified)
      let endpointUrl = `${upstreamUrl}/mcp`;
      if (options.agent) {
        endpointUrl = `${upstreamUrl}/agents/${options.agent}/mcp`;
      } else if (options.guild) {
        endpointUrl = `${upstreamUrl}/guilds/${options.guild}/mcp`;
      }

      // Test upstream connectivity before starting
      try {
        const testUrl = `${upstreamUrl}/health`;
        const testResponse = await fetch(testUrl, {
          signal: AbortSignal.timeout(5000),
        });

        if (!testResponse.ok) {
          console.error(`Error: Upstream server returned ${testResponse.status}`);
          process.exit(1);
        }
      } catch (error) {
        console.error(`Error: Unable to connect to upstream server at ${upstreamUrl}`);
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      // Monotonic counter for JSON-RPC request IDs to prevent collisions
      let nextId = 1;

      // Helper to forward requests to upstream HTTP endpoint
      async function forwardRequest(method: string, params?: unknown): Promise<unknown> {
        const response = await fetch(endpointUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: nextId++,
            method,
            params,
          }),
          signal: AbortSignal.timeout(timeout),
        });

        if (!response.ok) {
          throw new Error(`Upstream returned ${response.status}: ${await response.text()}`);
        }

        const result = await response.json();

        if (result.error) {
          throw new Error(result.error.message || 'Upstream error');
        }

        return result.result;
      }

      // Create MCP server with stdio transport
      const server = new Server(
        {
          name: 'mcp-aggregator-stdio',
          version: '0.1.0',
        },
        {
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
        }
      );

      // Register handlers that proxy to upstream

      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const result = await forwardRequest('tools/list');
        return result as { tools: unknown[] };
      });

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const result = await forwardRequest('tools/call', request.params);
        return result as { content: unknown[] };
      });

      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const result = await forwardRequest('resources/list');
        return result as { resources: unknown[] };
      });

      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const result = await forwardRequest('resources/read', request.params);
        return result as { contents: unknown[] };
      });

      server.setRequestHandler(ListPromptsRequestSchema, async () => {
        const result = await forwardRequest('prompts/list');
        return result as { prompts: unknown[] };
      });

      server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const result = await forwardRequest('prompts/get', request.params);
        return result as { messages: unknown[] };
      });

      // Connect to stdio transport
      const transport = new StdioServerTransport();
      await server.connect(transport);

      // Handle graceful shutdown
      const cleanup = async () => {
        try {
          await server.close();
        } catch (error) {
          console.error('Error during cleanup:', error);
        }
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

    } catch (error) {
      console.error('Fatal error:', error);
      process.exit(1);
    }
  });

program.parse();
