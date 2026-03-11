import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { Express, Request, Response } from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpServerOptions {
  port: number;
  bind: string;
  mcpServer: Server;
  transport: StreamableHTTPServerTransport;
}

/**
 * Creates and configures the HTTP server for the MCP aggregator.
 *
 * The server provides:
 * - POST /mcp - MCP Streamable HTTP endpoint
 * - GET /health - Health check endpoint
 */
export async function createHttpServer(options: HttpServerOptions): Promise<Express> {
  const { bind, mcpServer, transport } = options;

  // Create Express app with MCP defaults
  const app = createMcpExpressApp({ host: bind });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  });

  // MCP endpoint - handles all MCP protocol requests
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      // Parse request body if not already parsed
      let body = req.body;
      if (!body && req.readable) {
        // Body parser might not have run; collect manually
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        body = rawBody ? JSON.parse(rawBody) : undefined;
      }

      // Handle the request through the transport
      await transport.handleRequest(
        req as IncomingMessage,
        res as unknown as ServerResponse,
        body
      );
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  // Connect server to transport - this must succeed for the server to work
  try {
    await mcpServer.connect(transport);
  } catch (err) {
    console.error('FATAL: Failed to connect MCP server to transport:', err);
    throw new Error(`Failed to connect MCP server to transport: ${err instanceof Error ? err.message : String(err)}`);
  }

  return app;
}

/**
 * Starts the HTTP server and returns a cleanup function.
 */
export async function startHttpServer(
  app: Express,
  port: number,
  bind: string
): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, bind, () => {
      console.log(`HTTP server listening on http://${bind}:${port}`);
      console.log(`MCP endpoint: http://${bind}:${port}/mcp`);

      resolve({
        close: async () => {
          return new Promise<void>((resolveClose, rejectClose) => {
                    server.close((err?: Error) => {
              if (err) {
                rejectClose(err);
              } else {
                console.log('HTTP server closed');
                resolveClose();
              }
            });
          });
        },
      });
    });

    server.on('error', (err: Error) => {
      console.error('HTTP server error:', err);
      reject(err);
    });
  });
}
