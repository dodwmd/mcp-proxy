import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IUpstreamHandle } from './types.js';
import type { ResolvedServerConfig } from '../config/types.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';

/**
 * Stdio-based upstream connection.
 * Spawns a child process and communicates via stdin/stdout using MCP protocol.
 */
export class StdioUpstream implements IUpstreamHandle {
  readonly serverId: string;
  readonly alias: string;
  readonly sessionId: string;

  private readonly config: ResolvedServerConfig;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private process: ChildProcess | null = null;
  private initialized = false;
  private closed = false;

  constructor(config: ResolvedServerConfig, sessionId: string) {
    if (!config.command) {
      throw new Error(`Stdio server ${config.alias} missing command`);
    }
    this.serverId = config.id;
    this.alias = config.alias;
    this.sessionId = sessionId;
    this.config = config;
  }

  async init(clientInfo: { name: string; version: string }): Promise<void> {
    if (this.initialized) {
      throw new Error(`Upstream ${this.alias} already initialized`);
    }
    if (this.closed) {
      throw new Error(`Upstream ${this.alias} is closed`);
    }

    // Spawn child process
    const command = this.config.command!;
    const args = this.config.args || [];
    const env = { ...process.env, ...this.config.env };

    this.process = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
    });

    // Handle process errors
    this.process.on('error', (err) => {
      console.error(`[${this.alias}] Process error:`, err);
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[${this.alias}] stderr: ${data}`);
    });

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error(`Failed to spawn process for ${this.alias}`);
    }

    // Create MCP transport and client
    this.transport = new StdioClientTransport({
      command,
      args,
      env,
    });

    this.client = new Client(
      {
        name: clientInfo.name,
        version: clientInfo.version,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    // Connect client to transport
    await this.client.connect(this.transport);

    this.initialized = true;
  }

  async ping(): Promise<boolean> {
    if (!this.initialized || this.closed) {
      return false;
    }

    // Check if process is still running
    if (this.process && this.process.exitCode !== null) {
      return false;
    }

    // Try a simple MCP ping request
    try {
      await this.client?.request({ method: 'ping' }, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.initialized = false;

    // Close MCP client and transport
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        console.error(`[${this.alias}] Error closing client:`, err);
      }
      this.client = null;
    }

    // Kill child process
    if (this.process) {
      this.process.kill('SIGTERM');

      // Force kill after timeout
      setTimeout(() => {
        if (this.process && this.process.exitCode === null) {
          this.process.kill('SIGKILL');
        }
      }, 5000);

      this.process = null;
    }

    this.transport = null;
  }

  getClient(): Client {
    if (!this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }
    return this.client;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.request(
      { method: 'tools/list' },
      { timeout: this.config.timeoutMs }
    );

    const tools = (response as { tools?: unknown[] }).tools || [];
    return tools.map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || {},
    }));
  }

  async listResources(): Promise<ResourceDescriptor[]> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.request(
      { method: 'resources/list' },
      { timeout: this.config.timeoutMs }
    );

    const resources = (response as { resources?: unknown[] }).resources || [];
    return resources.map((r: any) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  async listPrompts(): Promise<PromptDescriptor[]> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.request(
      { method: 'prompts/list' },
      { timeout: this.config.timeoutMs }
    );

    const prompts = (response as { prompts?: unknown[] }).prompts || [];
    return prompts.map((p: any) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.request(
      {
        method: 'tools/call',
        params: { name, arguments: args },
      },
      { timeout: this.config.timeoutMs }
    );

    return response;
  }
}
