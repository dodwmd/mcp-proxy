import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';

/**
 * Upstream handle interface - represents a connection to one MCP server.
 * Lifecycle: constructed -> init() -> active -> close()
 */
export interface IUpstreamHandle {
  readonly serverId: string;
  readonly alias: string;
  readonly sessionId: string;

  /**
   * Initialize connection and perform MCP initialize handshake.
   * Throws if connection fails or initialize times out.
   */
  init(clientInfo: { name: string; version: string }): Promise<void>;

  /**
   * Check if connection is still alive.
   * Returns true if healthy, false if dead/errored.
   */
  ping(): Promise<boolean>;

  /**
   * Close connection and cleanup resources.
   */
  close(): Promise<void>;

  /**
   * Get underlying MCP SDK client for making protocol calls.
   */
  getClient(): Client;

  /**
   * Fetch tool list from this upstream.
   * Throws if upstream is not initialized or connection failed.
   */
  listTools(): Promise<ToolDescriptor[]>;

  /**
   * Fetch resource list from this upstream.
   */
  listResources(): Promise<ResourceDescriptor[]>;

  /**
   * Fetch prompt list from this upstream.
   */
  listPrompts(): Promise<PromptDescriptor[]>;

  /**
   * Call a tool on this upstream.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Factory function type for creating upstream handles.
 */
export type UpstreamFactory = (
  config: import('../config/types.js').ResolvedServerConfig,
  sessionId: string
) => IUpstreamHandle;
