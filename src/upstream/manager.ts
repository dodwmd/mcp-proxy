import type { IUpstreamHandle, UpstreamFactory } from './types.js';
import type { ResolvedServerConfig } from '../config/types.js';
import type { TransportType, UpstreamStatus } from '../types/common.js';
import { StdioUpstream } from './stdio.js';

/**
 * Transport registry - maps transport types to factory functions.
 * To add a new transport: import it and add an entry below.
 */
const TRANSPORT_REGISTRY: Record<TransportType, UpstreamFactory> = {
  stdio: (cfg, sessionId) => new StdioUpstream(cfg, sessionId),
  streamablehttp: () => {
    throw new Error('StreamableHTTP transport not yet implemented (M4)');
  },
  sse: () => {
    throw new Error('SSE transport not yet implemented (M4)');
  },
};

/**
 * Result of connecting to an upstream server.
 */
export interface UpstreamConnectionResult {
  handle: IUpstreamHandle | null;
  status: UpstreamStatus;
  error?: string;
}

/**
 * Manages connections to multiple upstream MCP servers.
 * Handles concurrent initialization, error handling, and lifecycle.
 */
export class UpstreamConnectionManager {
  private handles = new Map<string, IUpstreamHandle>();

  /**
   * Connect to all enabled servers from config.
   * Initializes connections concurrently up to the configured limit.
   */
  async connectAll(
    servers: ResolvedServerConfig[],
    sessionId: string,
    clientInfo: { name: string; version: string },
    concurrency = 10
  ): Promise<Map<string, UpstreamConnectionResult>> {
    const results = new Map<string, UpstreamConnectionResult>();
    const enabledServers = servers.filter((s) => s.enabled);

    // Connect in batches (honor concurrency limit)
    for (let i = 0; i < enabledServers.length; i += concurrency) {
      const batch = enabledServers.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((server) => this.connectOne(server, sessionId, clientInfo))
      );

      // Collect results
      batchResults.forEach((result, idx) => {
        const server = batch[idx];
        results.set(server.alias, result);
        if (result.handle) {
          this.handles.set(server.alias, result.handle);
        }
      });
    }

    return results;
  }

  /**
   * Connect to a single upstream server.
   */
  private async connectOne(
    server: ResolvedServerConfig,
    sessionId: string,
    clientInfo: { name: string; version: string }
  ): Promise<UpstreamConnectionResult> {
    try {
      const factory = TRANSPORT_REGISTRY[server.transport];
      if (!factory) {
        return {
          handle: null,
          status: 'error',
          error: `Unknown transport type: ${server.transport}`,
        };
      }

      const handle = factory(server, sessionId);
      await handle.init(clientInfo);

      return {
        handle,
        status: 'connected',
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[${server.alias}] Connection failed:`, errorMsg);
      return {
        handle: null,
        status: 'error',
        error: errorMsg,
      };
    }
  }

  /**
   * Get a connected upstream handle by alias.
   */
  get(alias: string): IUpstreamHandle | undefined {
    return this.handles.get(alias);
  }

  /**
   * Get all connected handles.
   */
  getAll(): IUpstreamHandle[] {
    return Array.from(this.handles.values());
  }

  /**
   * Check if an upstream is connected.
   */
  has(alias: string): boolean {
    return this.handles.has(alias);
  }

  /**
   * Close all upstream connections.
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.handles.values()).map((handle) =>
      handle.close().catch((err) => {
        console.error(`Error closing upstream ${handle.alias}:`, err);
      })
    );

    await Promise.all(closePromises);
    this.handles.clear();
  }

  /**
   * Close a specific upstream connection.
   */
  async close(alias: string): Promise<void> {
    const handle = this.handles.get(alias);
    if (handle) {
      await handle.close();
      this.handles.delete(alias);
    }
  }

  /**
   * Get connection status for all upstreams.
   */
  async getStatus(): Promise<
    Map<
      string,
      {
        alias: string;
        connected: boolean;
        healthy: boolean;
      }
    >
  > {
    const status = new Map();

    for (const [alias, handle] of this.handles.entries()) {
      const healthy = await handle.ping().catch((error) => {
        console.warn(`[${alias}] Health check failed:`, error);
        return false;
      });
      status.set(alias, {
        alias,
        connected: true,
        healthy,
      });
    }

    return status;
  }
}
