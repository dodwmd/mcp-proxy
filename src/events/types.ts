import type { ResolvedConfig } from '../config/types.js';

/**
 * Event payloads for the typed event bus.
 * All events are strongly typed to ensure type safety across the application.
 */
export type EventMap = {
  // Config events
  'config:changed': ConfigChangedPayload;
  'config:reload:start': void;
  'config:reload:complete': ConfigReloadCompletePayload;
  'config:reload:failed': ConfigReloadFailedPayload;

  // Session events
  'session:created': SessionCreatedPayload;
  'session:closed': SessionClosedPayload;

  // Tool events
  'tools:list_changed': ToolsListChangedPayload;

  // SSE broadcast events (for /api/events clients)
  'sse:broadcast': SSEBroadcastPayload;
};

export interface ConfigChangedPayload {
  prev: ResolvedConfig;
  next: ResolvedConfig;
}

export interface ConfigReloadCompletePayload {
  serversChanged: string[]; // aliases
  guildsChanged: string[]; // slugs
}

export interface ConfigReloadFailedPayload {
  error: Error;
}

export interface SessionCreatedPayload {
  sessionId: string;
  agentId?: string;
  toolCount: number;
  connectedAt: string; // ISO8601
}

export interface SessionClosedPayload {
  sessionId: string;
  agentId?: string;
  disconnectedAt: string; // ISO8601;
  reason: 'client_close' | 'server_close' | 'reload' | 'timeout';
  durationMs: number;
}

export interface ToolsListChangedPayload {
  sessionIds: string[];
  reason: string;
}

export interface SSEBroadcastPayload {
  event: string;
  data: unknown;
}
