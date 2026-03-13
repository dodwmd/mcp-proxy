import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IUpstreamHandle } from './types.js';
import type { ResolvedServerConfig } from '../config/types.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';
import { warn, error } from '../utils/logger.js';

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

    const command = this.config.command!;
    const args = this.config.args || [];
    // Filter out undefined values from env to satisfy Record<string, string> type
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...this.config.env }).filter(
        ([, v]) => v !== undefined
      )
    ) as Record<string, string>;

    // Create MCP transport (it will spawn the process internally)
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
        capabilities: {},
      }
    );

    // Connect client to transport (this spawns the process)
    await this.client.connect(this.transport);

    this.initialized = true;
  }

  async ping(): Promise<boolean> {
    if (!this.initialized || this.closed) {
      return false;
    }

    // Try a simple MCP ping request
    try {
      await this.client?.ping();
      return true;
    } catch (err) {
      warn(
        { alias: this.alias, error: err },
        'Ping failed'
      );
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.initialized = false;

    // Close MCP client (which will close the transport and kill the process)
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        error({ alias: this.alias, error: err }, 'Error closing client');
      }
      this.client = null;
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

    const response = await this.client.listTools();
    const tools = response.tools || [];
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || {},
    }));
  }

  async listResources(): Promise<ResourceDescriptor[]> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.listResources();
    const resources = response.resources || [];
    return resources.map((r) => ({
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

    const response = await this.client.listPrompts();
    const prompts = response.prompts || [];
    return prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.callTool({ name, arguments: args });
    return response;
  }

  async readResource(uri: string): Promise<unknown> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.readResource({ uri });
    return response;
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized || !this.client) {
      throw new Error(`Upstream ${this.alias} not initialized`);
    }

    const response = await this.client.getPrompt({
      name,
      arguments: args as Record<string, string> | undefined,
    });
    return response;
  }
}
