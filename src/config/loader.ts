import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { resolveEnvVarsInObject } from './env.js';
import type {
  ResolvedConfig,
  ResolvedServerConfig,
  GuildConfig,
  AgentConfig,
  RuntimeConfig,
  IConfigLoader,
} from './types.js';
import { ConfigValidationError } from './types.js';

interface RawYamlConfig {
  port?: number;
  apiPort?: number;
  publicUrl?: string;
  bind?: string;
  home?: string;
  migrationPrompt?: string;
  toolWarnThreshold?: number;
  upstreamConcurrency?: number;
  reloadDebounceMs?: number;
  httpKeepaliveMs?: number;
  disableGuildHints?: boolean;
  disableGuildEndpoints?: boolean;
  allowPrivateUrls?: boolean;
  servers?: RawServerConfig[];
  guilds?: RawGuildConfig[];
  agents?: RawAgentConfig[];
}

interface RawServerConfig {
  alias: string;
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeout_ms?: number;
  enabled?: boolean;
}

interface RawGuildConfig {
  slug: string;
  name: string;
  description?: string;
  color?: string;
  servers?: string[];
}

interface RawAgentConfig {
  id: string;
  display_name?: string;
  guilds?: string[];
  direct_servers?: string[];
}

export class YamlConfigLoader implements IConfigLoader {
  constructor(private readonly configPath: string) {}

  load(): ResolvedConfig {
    // Check for symlinks (security requirement from SPEC)
    const realPath = fs.realpathSync(this.configPath);
    if (realPath !== this.configPath) {
      throw new ConfigValidationError(
        `Symlink detected in config path: ${this.configPath} → ${realPath}`,
        ['Config file must not be a symlink']
      );
    }

    // Read and parse YAML
    const content = fs.readFileSync(this.configPath, 'utf-8');
    const raw: RawYamlConfig = parse(content);

    // Resolve env vars in the entire config
    const resolved = resolveEnvVarsInObject(raw);

    // Validate and build ResolvedConfig
    return this.buildResolvedConfig(resolved);
  }

  validate(): { valid: boolean; errors: string[] } {
    try {
      this.load();
      return { valid: true, errors: [] };
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        return { valid: false, errors: err.errors };
      }
      return { valid: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
  }

  watch(onChange: (next: ResolvedConfig, prev: ResolvedConfig) => void): () => void {
    // Simplified watcher for M1 - full chokidar implementation with debouncing in watcher.ts
    let prev = this.load();

    const watcher = fs.watch(this.configPath, (eventType) => {
      if (eventType === 'change') {
        try {
          const next = this.load();
          onChange(next, prev);
          prev = next;
        } catch (err) {
          console.error('[ERROR] Config reload failed:', err);
        }
      }
    });

    return () => watcher.close();
  }

  private buildResolvedConfig(raw: RawYamlConfig): ResolvedConfig {
    const errors: string[] = [];

    // Coerce numeric fields (env vars come back as strings)
    const port = typeof raw.port === 'string' ? parseInt(raw.port, 10) : raw.port ?? 4000;
    const apiPort = typeof raw.apiPort === 'string' ? parseInt(raw.apiPort, 10) : raw.apiPort;
    const toolWarnThreshold = typeof raw.toolWarnThreshold === 'string' ? parseInt(raw.toolWarnThreshold, 10) : raw.toolWarnThreshold ?? 100;
    const upstreamConcurrency = typeof raw.upstreamConcurrency === 'string' ? parseInt(raw.upstreamConcurrency, 10) : raw.upstreamConcurrency ?? 10;
    const reloadDebounceMs = typeof raw.reloadDebounceMs === 'string' ? parseInt(raw.reloadDebounceMs, 10) : raw.reloadDebounceMs ?? 300;
    const httpKeepaliveMs = typeof raw.httpKeepaliveMs === 'string' ? parseInt(raw.httpKeepaliveMs, 10) : raw.httpKeepaliveMs ?? 60000;

    // Build runtime config with defaults
    const runtime: RuntimeConfig = {
      port,
      apiPort,
      publicUrl: raw.publicUrl ?? `http://localhost:${port}`,
      bindAddress: raw.bind ?? '0.0.0.0',
      home: raw.home ?? `${process.env.HOME}/.mcp-aggregator`,
      dbPath: `${raw.home ?? process.env.HOME + '/.mcp-aggregator'}/db.sqlite`,
      migrationPrompt: (raw.migrationPrompt as 'never' | 'always' | 'interactive') ?? 'interactive',
      toolWarnThreshold,
      upstreamConcurrency,
      reloadDebounceMs,
      httpKeepaliveMs,
      disableGuildHints: raw.disableGuildHints ?? false,
      disableGuildEndpoints: raw.disableGuildEndpoints ?? false,
      allowPrivateUrls: raw.allowPrivateUrls ?? false,
    };

    // Build servers
    const servers: ResolvedServerConfig[] = [];
    const aliases = new Set<string>();

    for (const rawServer of raw.servers ?? []) {
      if (!rawServer.alias || !rawServer.name || !rawServer.transport) {
        errors.push(`Server missing required fields: ${JSON.stringify(rawServer)}`);
        continue;
      }

      if (aliases.has(rawServer.alias)) {
        errors.push(`Duplicate server alias: ${rawServer.alias}`);
        continue;
      }

      aliases.add(rawServer.alias);

      const timeoutMs = typeof rawServer.timeout_ms === 'string'
        ? parseInt(rawServer.timeout_ms, 10)
        : rawServer.timeout_ms ?? 30000;

      servers.push({
        id: randomUUID(),
        alias: rawServer.alias,
        name: rawServer.name,
        transport: rawServer.transport as 'stdio' | 'streamablehttp' | 'sse',
        enabled: rawServer.enabled ?? true,
        timeoutMs,
        command: rawServer.command,
        args: rawServer.args,
        env: rawServer.env,
        url: rawServer.url,
        headers: rawServer.headers,
      });
    }

    // Build guilds
    const guilds: GuildConfig[] = [];
    const slugs = new Set<string>();

    for (const rawGuild of raw.guilds ?? []) {
      if (!rawGuild.slug || !rawGuild.name) {
        errors.push(`Guild missing required fields: ${JSON.stringify(rawGuild)}`);
        continue;
      }

      if (slugs.has(rawGuild.slug)) {
        errors.push(`Duplicate guild slug: ${rawGuild.slug}`);
        continue;
      }

      slugs.add(rawGuild.slug);

      guilds.push({
        id: randomUUID(),
        slug: rawGuild.slug,
        name: rawGuild.name,
        description: rawGuild.description,
        color: rawGuild.color ?? '#6366f1',
        serverAliases: rawGuild.servers ?? [],
      });
    }

    // Build agents
    const agents: AgentConfig[] = [];

    for (const rawAgent of raw.agents ?? []) {
      if (!rawAgent.id) {
        errors.push(`Agent missing id: ${JSON.stringify(rawAgent)}`);
        continue;
      }

      agents.push({
        id: rawAgent.id,
        displayName: rawAgent.display_name,
        guildSlugs: rawAgent.guilds ?? [],
        directServerAliases: rawAgent.direct_servers ?? [],
      });
    }

    if (errors.length > 0) {
      throw new ConfigValidationError('Config validation failed', errors);
    }

    return {
      runtime,
      servers,
      guilds,
      agents,
    };
  }
}
