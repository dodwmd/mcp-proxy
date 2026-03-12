import type { IUpstreamHandle } from '../upstream/types.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor, UpstreamStatus } from '../types/common.js';
import type { ResolvedServerConfig } from '../config/types.js';

export type SessionState = 'initializing' | 'active' | 'reloading' | 'draining' | 'closed';

export interface SessionContext {
  readonly id: string;
  readonly state: SessionState;
  readonly connectedAt: Date;
  readonly upstreamHandles: ReadonlyMap<string, IUpstreamHandle>; // alias → handle
  readonly upstreamStatuses: ReadonlyMap<string, UpstreamStatus>; // alias → status
  readonly toolCount: number;
  readonly inFlightCalls: number;
}

export interface CreateSessionParams {
  sessionId: string;
  clientInfo: { name: string; version?: string };
  serverConfigs: ResolvedServerConfig[]; // Which servers to connect for this session
}

export interface IAggregatorEngine {
  /**
   * Create a new MCP session and connect to specified upstreams.
   * Returns session context with connected upstream handles.
   */
  createSession(params: CreateSessionParams): Promise<SessionContext>;

  /**
   * Close a session gracefully, killing all upstream connections.
   */
  closeSession(sessionId: string): Promise<void>;

  /**
   * Get session context by ID.
   */
  getSession(sessionId: string): SessionContext | undefined;

  /**
   * List all tools from all upstreams in a session (namespaced).
   */
  listTools(sessionId: string): Promise<ToolDescriptor[]>;

  /**
   * List all resources from all upstreams in a session (namespaced).
   */
  listResources(sessionId: string): Promise<ResourceDescriptor[]>;

  /**
   * List all prompts from all upstreams in a session (namespaced).
   */
  listPrompts(sessionId: string): Promise<PromptDescriptor[]>;

  /**
   * Call a namespaced tool.
   * Parses alias prefix, routes to correct upstream.
   */
  callTool(sessionId: string, namespacedName: string, args: Record<string, unknown>): Promise<unknown>;

  /**
   * Read a namespaced resource.
   */
  readResource(sessionId: string, namespacedUri: string): Promise<unknown>;

  /**
   * Get a namespaced prompt with arguments.
   */
  getPrompt(
    sessionId: string,
    namespacedName: string,
    args?: Record<string, unknown>
  ): Promise<unknown>;
}
