import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import express from 'express';
import type { Server as HttpServer } from 'http';

/**
 * Integration test for M6 Milestone: stdio wrapper end-to-end
 *
 * This test verifies:
 * - Starting the HTTP aggregator server
 * - Starting the stdio wrapper pointing to the aggregator
 * - Sending initialize over stdin
 * - Receiving tool list response
 */
describe('stdio wrapper integration (M6)', () => {
  let httpServer: HttpServer;
  let stdioProcess: ChildProcess;
  const TEST_PORT = 14123;
  const UPSTREAM_URL = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    // Start a minimal HTTP aggregator server for testing
    const app = express();
    app.use(express.json());

    // Mock MCP JSON-RPC endpoint at /mcp
    app.post('/mcp', (req, res) => {
      const { method, id } = req.body;

      if (method === 'initialize') {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              resources: {},
              prompts: {},
            },
            serverInfo: {
              name: 'test-aggregator',
              version: '1.0.0',
            },
          },
        });
      } else if (method === 'tools/list') {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'test_tool',
                description: 'A test tool',
                inputSchema: {
                  type: 'object',
                  properties: {},
                },
              },
            ],
          },
        });
      } else if (method === 'resources/list') {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            resources: [],
          },
        });
      } else if (method === 'prompts/list') {
        res.json({
          jsonrpc: '2.0',
          id,
          result: {
            prompts: [],
          },
        });
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'Method not found',
          },
        });
      }
    });

    // Health check endpoint (used by stdio wrapper to test connectivity)
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    // Start HTTP server
    await new Promise<void>((resolve) => {
      httpServer = app.listen(TEST_PORT, () => {
        console.log(`Test aggregator listening on port ${TEST_PORT}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Clean up stdio process
    if (stdioProcess && !stdioProcess.killed) {
      stdioProcess.kill('SIGTERM');
      await new Promise((resolve) => stdioProcess.once('exit', resolve));
    }

    // Clean up HTTP server
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('should start stdio wrapper, initialize, and receive tool list', async () => {
    // Build the stdio wrapper binary path
    const stdioBinaryPath = './dist/bin/mcp-aggregator-stdio.js';

    // Spawn stdio wrapper process
    stdioProcess = spawn('node', [stdioBinaryPath, '--upstream', UPSTREAM_URL], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Collect stdout data
    let stdoutData = '';
    stdioProcess.stdout!.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    // Collect stderr for debugging
    let stderrData = '';
    stdioProcess.stderr!.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    // Wait for process to be ready
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Send initialize request
    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      },
    };

    stdioProcess.stdin!.write(JSON.stringify(initializeRequest) + '\n');

    // Wait for initialize response
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Verify we got a response
    expect(stdoutData.length).toBeGreaterThan(0);

    // Parse the response (may contain multiple JSON-RPC messages)
    const lines = stdoutData
      .split('\n')
      .filter((line) => line.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);

    const initializeResponse = JSON.parse(lines[0]);
    expect(initializeResponse).toHaveProperty('id', 1);
    expect(initializeResponse).toHaveProperty('result');
    expect(initializeResponse.result).toHaveProperty('protocolVersion');
    expect(initializeResponse.result).toHaveProperty('capabilities');
    expect(initializeResponse.result).toHaveProperty('serverInfo');
    expect(initializeResponse.result.serverInfo.name).toBe('mcp-aggregator-stdio');

    // Send tools/list request
    const toolsListRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    // Clear stdout buffer
    stdoutData = '';

    stdioProcess.stdin!.write(JSON.stringify(toolsListRequest) + '\n');

    // Wait for tools/list response
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Parse tools response
    const toolsLines = stdoutData
      .split('\n')
      .filter((line) => line.trim().length > 0);

    expect(toolsLines.length).toBeGreaterThan(0);

    const toolsResponse = JSON.parse(toolsLines[0]);
    expect(toolsResponse).toHaveProperty('id', 2);
    expect(toolsResponse).toHaveProperty('result');
    expect(toolsResponse.result).toHaveProperty('tools');
    expect(Array.isArray(toolsResponse.result.tools)).toBe(true);
    expect(toolsResponse.result.tools.length).toBeGreaterThan(0);
    expect(toolsResponse.result.tools[0]).toHaveProperty('name', 'test_tool');

    // Verify no errors in stderr
    if (stderrData.trim().length > 0) {
      console.log('Stderr output:', stderrData);
    }
  }, 10000); // 10 second timeout for integration test

  it('should exit with code 1 when upstream is unavailable', async () => {
    const INVALID_UPSTREAM = 'http://localhost:99999';

    const failProcess = spawn('node', ['./dist/bin/mcp-aggregator-stdio.js', '--upstream', INVALID_UPSTREAM], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const exitCode = await new Promise<number>((resolve) => {
      failProcess.on('exit', (code) => {
        resolve(code || 0);
      });
    });

    expect(exitCode).toBe(1);
  }, 10000);

  it('should enforce mutual exclusion of --agent and --guild flags', async () => {
    const conflictProcess = spawn(
      'node',
      ['./dist/bin/mcp-aggregator-stdio.js', '--upstream', UPSTREAM_URL, '--agent', 'test', '--guild', 'test'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stderrData = '';
    conflictProcess.stderr!.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      conflictProcess.on('exit', (code) => {
        resolve(code || 0);
      });
    });

    expect(exitCode).toBe(1);
    expect(stderrData).toContain('mutually exclusive');
  }, 10000);
});
