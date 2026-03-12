import type { TransportType } from '../types/common.js';

export interface ResolvedConfig {
  runtime: RuntimeConfig;
  servers: ResolvedServerConfig[];
  guilds: GuildConfig[];
  agents: AgentConfig[];
}

export interface RuntimeConfig {
  port: number;
  apiPort?: number;
  publicUrl: string;
  bindAddress: string;
  home: string;
  dbPath: string;
  migrationPrompt: 'never' | 'always' | 'interactive';
  toolWarnThreshold: number;
  upstreamConcurrency: number;
  reloadDebounceMs: number;
  httpKeepaliveMs: number;
  disableGuildHints: boolean;
  disableGuildEndpoints: boolean;
  allowPrivateUrls: boolean;
}

export interface ResolvedServerConfig {
  id: string;
  alias: string;
  name: string;
  transport: TransportType;
  enabled: boolean;
  timeoutMs: number;

  // stdio-specific
  command?: string;
  args?: string[];
  env?: Record<string, string>;  // Already resolved from ${VAR}

  // http/sse-specific
  url?: string;
  headers?: Record<string, string>;  // Already resolved from ${VAR}
}

export interface GuildConfig {
  id: string;
  slug: string;
  name: string;
  description?: string;
  color: string;
  serverAliases: string[];
}

export interface AgentConfig {
  id: string;
  displayName?: string;
  guildSlugs: string[];
  directServerAliases: string[];
}

export interface IConfigLoader {
  /**
   * Load and parse configuration. Throws ConfigValidationError on failure.
   */
  load(): ResolvedConfig;

  /**
   * Watch for config changes and invoke callback with new and previous config.
   * Returns cleanup function to stop watching.
   * @param onChange - Called when config successfully reloads with new and previous config
   * @param onError - Optional callback for reload failures. If not provided, errors are logged to console.
   */
  watch(
    onChange: (next: ResolvedConfig, prev: ResolvedConfig) => void,
    onError?: (error: Error) => void
  ): () => void;

  /**
   * Validate config without loading (for CLI validate command).
   */
  validate(): { valid: boolean; errors: string[] };
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: string[]
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
