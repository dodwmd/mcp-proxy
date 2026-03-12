import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { IUpstreamHandle } from './types.js';
import type { ResolvedServerConfig } from '../config/types.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';
import { validateUrl } from './url-validation.js';

/**
 * SSE (Server-Sent Events)-based upstream connection (legacy).
 * Uses HTTP POST for sending messages and Server-Sent Events for receiving messages.
 * @deprecated SSE transport is deprecated. Prefer StreamableHTTP where possible.
 */
export class SSEUpstream implements IUpstreamHandle {
  readonly serverId: string;
  readonly alias: string;
  readonly sessionId: string;

  private readonly config: ResolvedServerConfig;
  private readonly keepaliveMs: number;
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private initialized = false;
  private closed = false;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(
    config: ResolvedServerConfig,
    sessionId: string,
    allowPrivateUrls: boolean,
    keepaliveMs: number
  ) {
    if (!config.url) {
      throw new Error(`SSE server ${config.alias} missing url`);
    }

    this.serverId = config.id;
    this.alias = config.alias;
    this.sessionId = sessionId;
    this.config = config;
    this.keepaliveMs = keepaliveMs;

    // Validate URL immediately
    validateUrl(config.url, allowPrivateUrls, config.alias);
  }

  async init(clientInfo: { name: string; version: string }): Promise<void> {
    if (this.initialized) {
      throw new Error(`Upstream ${this.alias} already initialized`);
    }
    if (this.closed) {
      throw new Error(`Upstream ${this.alias} is closed`);
    }

    const url = new URL(this.config.url!);

    // Create SSE transport
    // Note: SSE transport doesn't have reconnection options like StreamableHTTP
    // It doesn't auto-reconnect by default, which meets our requirements
    this.transport = new SSEClientTransport(url, {
      requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
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

    // Connect client to transport
    await this.client.connect(this.transport);

    this.initialized = true;

    // Start HTTP keepalive timer
    this.startKeepaliveTimer();
  }

  async ping(): Promise<boolean> {
    if (!this.initialized || this.closed) {
      return false;
    }

    // Try a simple MCP ping request
    try {
      await this.client?.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    // Stop keepalive timer
    this.stopKeepaliveTimer();

    this.closed = true;
    this.initialized = false;

    // Close MCP client (which will close the transport)
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        console.error(`[${this.alias}] Error closing client:`, err);
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

  /**
   * Start HTTP keepalive timer to periodically ping the upstream.
   */
  private startKeepaliveTimer(): void {
    if (this.keepaliveMs <= 0) {
      return; // Keepalive disabled
    }

    this.keepaliveTimer = setInterval(async () => {
      try {
        const healthy = await this.ping();
        if (!healthy) {
          console.warn(`[${this.alias}] HTTP keepalive ping failed, connection may be stale`);
        }
      } catch (err) {
        console.error(`[${this.alias}] HTTP keepalive error:`, err);
      }
    }, this.keepaliveMs);

    // Don't prevent process exit
    this.keepaliveTimer.unref();
  }

  /**
   * Stop HTTP keepalive timer.
   */
  private stopKeepaliveTimer(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
