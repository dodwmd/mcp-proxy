import { UpstreamConnectionManager } from '../upstream/manager.js';
import type { IUpstreamHandle } from '../upstream/types.js';
import type { ToolDescriptor, ResourceDescriptor, PromptDescriptor } from '../types/common.js';
import {
  namespaceTool,
  namespaceResource,
  namespacePrompt,
  parseNamespacedName,
  parseNamespacedUri,
} from './namespace.js';
import type {
  IAggregatorEngine,
  SessionContext,
  CreateSessionParams,
  SessionState,
} from './types.js';

export class AggregatorEngine implements IAggregatorEngine {
  private readonly sessions = new Map<string, InternalSessionContext>();
  private readonly upstreamManager: UpstreamConnectionManager;

  constructor() {
    this.upstreamManager = new UpstreamConnectionManager();
  }

  async createSession(params: CreateSessionParams): Promise<SessionContext> {
    const { sessionId, clientInfo, serverConfigs } = params;

    // Connect to all upstreams
    const connectionResults = await this.upstreamManager.connectAll(
      serverConfigs,
      sessionId,
      {
        name: clientInfo.name,
        version: clientInfo.version ?? '1.0.0',
      }
    );

    // Separate successful connections from failures
    const upstreamHandles = new Map<string, IUpstreamHandle>();
    const upstreamStatuses = new Map<string, 'connected' | 'error' | 'skipped'>();

    for (const [alias, result] of connectionResults) {
      if (result.status === 'connected' && result.handle) {
        upstreamHandles.set(alias, result.handle);
        upstreamStatuses.set(alias, 'connected');
      } else {
        upstreamStatuses.set(alias, result.status);
        console.error(`[${sessionId}] Failed to connect to upstream "${alias}": ${result.error}`);
      }
    }

    // Create session context
    const session: InternalSessionContext = {
      id: sessionId,
      state: 'active',
      connectedAt: new Date(),
      upstreamHandles,
      upstreamStatuses,
      toolCount: 0, // Will be calculated on first listTools() call
      inFlightCalls: 0,
    };

    this.sessions.set(sessionId, session);

    return this.toPublicContext(session);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[${sessionId}] Session not found for closeSession`);
      return;
    }

    // Mark as closed
    session.state = 'closed';

    // Close all upstream connections
    const closePromises: Promise<void>[] = [];
    for (const [alias, handle] of session.upstreamHandles) {
      console.log(`[${sessionId}] Closing upstream "${alias}"`);
      closePromises.push(
        handle.close().catch((error) => {
          console.error(`[${sessionId}] Error closing upstream "${alias}": ${error}`);
        })
      );
    }

    await Promise.all(closePromises);

    // Remove session from registry
    this.sessions.delete(sessionId);
  }

  getSession(sessionId: string): SessionContext | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.toPublicContext(session) : undefined;
  }

  async listTools(sessionId: string): Promise<ToolDescriptor[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state !== 'active') {
      throw new Error(`Session is not active: ${session.state}`);
    }

    // Fetch tools from all connected upstreams in parallel
    const toolPromises: Promise<{ alias: string; tools: ToolDescriptor[] }>[] = [];

    for (const [alias, handle] of session.upstreamHandles) {
      toolPromises.push(
        handle
          .listTools()
          .then((tools) => ({ alias, tools }))
          .catch((error) => {
            console.error(`[${sessionId}] Error listing tools from "${alias}": ${error}`);
            return { alias, tools: [] };
          })
      );
    }

    const results = await Promise.all(toolPromises);

    // Namespace and merge all tools
    const allTools: ToolDescriptor[] = [];
    for (const { alias, tools } of results) {
      for (const tool of tools) {
        allTools.push(namespaceTool(alias, tool));
      }
    }

    // Update tool count
    session.toolCount = allTools.length;

    return allTools;
  }

  async listResources(sessionId: string): Promise<ResourceDescriptor[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state !== 'active') {
      throw new Error(`Session is not active: ${session.state}`);
    }

    // Fetch resources from all connected upstreams in parallel
    const resourcePromises: Promise<{ alias: string; resources: ResourceDescriptor[] }>[] = [];

    for (const [alias, handle] of session.upstreamHandles) {
      resourcePromises.push(
        handle
          .listResources()
          .then((resources) => ({ alias, resources }))
          .catch((error) => {
            console.error(`[${sessionId}] Error listing resources from "${alias}": ${error}`);
            return { alias, resources: [] };
          })
      );
    }

    const results = await Promise.all(resourcePromises);

    // Namespace and merge all resources
    const allResources: ResourceDescriptor[] = [];
    for (const { alias, resources } of results) {
      for (const resource of resources) {
        allResources.push(namespaceResource(alias, resource));
      }
    }

    return allResources;
  }

  async listPrompts(sessionId: string): Promise<PromptDescriptor[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state !== 'active') {
      throw new Error(`Session is not active: ${session.state}`);
    }

    // Fetch prompts from all connected upstreams in parallel
    const promptPromises: Promise<{ alias: string; prompts: PromptDescriptor[] }>[] = [];

    for (const [alias, handle] of session.upstreamHandles) {
      promptPromises.push(
        handle
          .listPrompts()
          .then((prompts) => ({ alias, prompts }))
          .catch((error) => {
            console.error(`[${sessionId}] Error listing prompts from "${alias}": ${error}`);
            return { alias, prompts: [] };
          })
      );
    }

    const results = await Promise.all(promptPromises);

    // Namespace and merge all prompts
    const allPrompts: PromptDescriptor[] = [];
    for (const { alias, prompts } of results) {
      for (const prompt of prompts) {
        allPrompts.push(namespacePrompt(alias, prompt));
      }
    }

    return allPrompts;
  }

  async callTool(sessionId: string, namespacedName: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state !== 'active') {
      throw new Error(`Session is not active: ${session.state}`);
    }

    // Parse namespaced name to extract alias and original tool name
    const parsed = parseNamespacedName(namespacedName);
    if (!parsed) {
      throw new Error(`Invalid namespaced tool name format: ${namespacedName}`);
    }

    const { alias, name } = parsed;

    // Find upstream handle
    const handle = session.upstreamHandles.get(alias);
    if (!handle) {
      throw new Error(`Upstream not found or not connected: ${alias}`);
    }

    // Track in-flight call
    session.inFlightCalls++;

    try {
      // Forward call to upstream
      const result = await handle.callTool(name, args);
      return result;
    } finally {
      session.inFlightCalls--;
    }
  }

  async readResource(sessionId: string, namespacedUri: string): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state !== 'active') {
      throw new Error(`Session is not active: ${session.state}`);
    }

    // Parse namespaced URI to extract alias and original URI
    const parsed = parseNamespacedUri(namespacedUri);
    if (!parsed) {
      throw new Error(`Invalid namespaced resource URI format: ${namespacedUri}`);
    }

    const { alias, uri: _uri } = parsed;

    // Find upstream handle
    const handle = session.upstreamHandles.get(alias);
    if (!handle) {
      throw new Error(`Upstream not found or not connected: ${alias}`);
    }

    // Forward to upstream (note: IUpstreamHandle doesn't have readResource yet)
    // This would need to be added to IUpstreamHandle interface
    throw new Error('Resource reading not yet implemented');
  }

  async getPrompt(
    sessionId: string,
    namespacedName: string,
    _args?: Record<string, unknown>
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state !== 'active') {
      throw new Error(`Session is not active: ${session.state}`);
    }

    // Parse namespaced name to extract alias and original prompt name
    const parsed = parseNamespacedName(namespacedName);
    if (!parsed) {
      throw new Error(`Invalid namespaced prompt name format: ${namespacedName}`);
    }

    const { alias, name: _name } = parsed;

    // Find upstream handle
    const handle = session.upstreamHandles.get(alias);
    if (!handle) {
      throw new Error(`Upstream not found or not connected: ${alias}`);
    }

    // Forward to upstream (note: IUpstreamHandle doesn't have getPrompt yet)
    // This would need to be added to IUpstreamHandle interface
    throw new Error('Prompt retrieval not yet implemented');
  }

  private toPublicContext(session: InternalSessionContext): SessionContext {
    return {
      id: session.id,
      state: session.state,
      connectedAt: session.connectedAt,
      upstreamHandles: session.upstreamHandles,
      upstreamStatuses: session.upstreamStatuses,
      toolCount: session.toolCount,
      inFlightCalls: session.inFlightCalls,
    };
  }
}

// Internal mutable session context
interface InternalSessionContext {
  id: string;
  state: SessionState;
  connectedAt: Date;
  upstreamHandles: Map<string, IUpstreamHandle>;
  upstreamStatuses: Map<string, 'connected' | 'error' | 'skipped'>;
  toolCount: number;
  inFlightCalls: number;
}
