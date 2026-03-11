// Shared types used across multiple layers

export type TransportType = 'stdio' | 'streamablehttp' | 'sse';

export type SessionState = 'initializing' | 'active' | 'reloading' | 'draining' | 'closed';

export type UpstreamStatus = 'connected' | 'error' | 'skipped';

export interface ClientInfo {
  name: string;
  version?: string;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface PromptDescriptor {
  name: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}
