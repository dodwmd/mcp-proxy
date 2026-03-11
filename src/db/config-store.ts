import { eq, inArray } from 'drizzle-orm';
import type { DbClient } from './client.js';
import type { ResolvedConfig } from '../config/types.js';
import {
  upstreamServers,
  upstreamEnvVars,
  upstreamHeaders,
  guilds,
  guildServers,
  agents,
  agentGuilds,
  agentDirectServers,
  type InsertUpstreamServer,
  type InsertGuild,
  type InsertAgent,
} from './schema.js';

/**
 * Interface for syncing configuration to the database.
 * Handles YAML-managed entities (servers, guilds, agents) and ensures
 * the database reflects the current YAML config state.
 */
export interface IConfigStore {
  /**
   * Sync the entire config to the database.
   * - Upserts yaml_managed entities
   * - Removes yaml_managed entities no longer in config
   * - Seeds default guild if not present
   */
  syncConfig(config: ResolvedConfig): Promise<void>;

  /**
   * Ensure default guild exists (system guild for fallback routing).
   */
  ensureDefaultGuild(): Promise<string>;
}

export class SqliteConfigStore implements IConfigStore {
  constructor(private readonly db: DbClient) {}

  async syncConfig(config: ResolvedConfig): Promise<void> {
    // Ensure default guild exists first
    const defaultGuildId = await this.ensureDefaultGuild();

    // Sync servers
    await this.syncServers(config);

    // Sync guilds (excluding default which is system-managed)
    await this.syncGuilds(config, defaultGuildId);

    // Sync agents
    await this.syncAgents(config);
  }

  async ensureDefaultGuild(): Promise<string> {
    const defaultSlug = 'default';
    const now = new Date().toISOString();

    // Check if default guild exists
    const existing = await this.db.query.guilds.findFirst({
      where: eq(guilds.slug, defaultSlug),
    });

    if (existing) {
      return existing.id;
    }

    // Create default guild
    const newGuild: InsertGuild = {
      id: crypto.randomUUID(),
      slug: defaultSlug,
      name: 'Default',
      description: 'System default guild - all servers available when no guild specified',
      color: '#6366f1',
      isSystem: true,
      yamlManaged: false,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(guilds).values(newGuild);
    return newGuild.id;
  }

  private async syncServers(config: ResolvedConfig): Promise<void> {
    const now = new Date().toISOString();
    const yamlServerAliases = config.servers.map((s) => s.alias);

    // Upsert each server from YAML
    for (const server of config.servers) {
      const serverData: InsertUpstreamServer = {
        id: server.id,
        alias: server.alias,
        name: server.name,
        transportType: server.transport,
        command: server.command ?? null,
        args: server.args ?? null,
        url: server.url ?? null,
        enabled: server.enabled,
        timeoutMs: server.timeoutMs,
        yamlManaged: true,
        createdAt: now,
        updatedAt: now,
        lastConnectedAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        consecutiveErrors: 0,
        cachedToolCount: 0,
      };

      // Upsert server
      await this.db
        .insert(upstreamServers)
        .values(serverData)
        .onConflictDoUpdate({
          target: upstreamServers.alias,
          set: {
            name: serverData.name,
            transportType: serverData.transportType,
            command: serverData.command,
            args: serverData.args,
            url: serverData.url,
            enabled: serverData.enabled,
            timeoutMs: serverData.timeoutMs,
            updatedAt: now,
          },
        });

      // Get server ID after upsert
      const upsertedServer = await this.db.query.upstreamServers.findFirst({
        where: eq(upstreamServers.alias, server.alias),
      });

      if (!upsertedServer) continue;

      // Sync env vars
      await this.db.delete(upstreamEnvVars).where(eq(upstreamEnvVars.serverId, upsertedServer.id));
      if (server.env) {
        const envVarsData = Object.entries(server.env).map(([key, value]) => ({
          id: crypto.randomUUID(),
          serverId: upsertedServer.id,
          key,
          value,
          createdAt: now,
          updatedAt: now,
        }));
        if (envVarsData.length > 0) {
          await this.db.insert(upstreamEnvVars).values(envVarsData);
        }
      }

      // Sync headers
      await this.db.delete(upstreamHeaders).where(eq(upstreamHeaders.serverId, upsertedServer.id));
      if (server.headers) {
        const headersData = Object.entries(server.headers).map(([key, value]) => ({
          id: crypto.randomUUID(),
          serverId: upsertedServer.id,
          key,
          value,
          createdAt: now,
          updatedAt: now,
        }));
        if (headersData.length > 0) {
          await this.db.insert(upstreamHeaders).values(headersData);
        }
      }
    }

    // Remove yaml_managed servers no longer in config
    const allYamlServers = await this.db.query.upstreamServers.findMany({
      where: eq(upstreamServers.yamlManaged, true),
    });

    const serversToRemove = allYamlServers.filter(
      (s) => !yamlServerAliases.includes(s.alias)
    );

    if (serversToRemove.length > 0) {
      await this.db.delete(upstreamServers).where(
        inArray(
          upstreamServers.id,
          serversToRemove.map((s) => s.id)
        )
      );
    }
  }

  private async syncGuilds(config: ResolvedConfig, defaultGuildId: string): Promise<void> {
    const now = new Date().toISOString();
    const yamlGuildSlugs = config.guilds.map((g) => g.slug);

    // Upsert each guild from YAML
    for (const guild of config.guilds) {
      const guildData: InsertGuild = {
        id: guild.id,
        slug: guild.slug,
        name: guild.name,
        description: guild.description ?? null,
        color: guild.color,
        isSystem: false,
        yamlManaged: true,
        createdAt: now,
        updatedAt: now,
      };

      await this.db
        .insert(guilds)
        .values(guildData)
        .onConflictDoUpdate({
          target: guilds.slug,
          set: {
            name: guildData.name,
            description: guildData.description,
            color: guildData.color,
            updatedAt: now,
          },
        });

      // Get guild ID after upsert
      const upsertedGuild = await this.db.query.guilds.findFirst({
        where: eq(guilds.slug, guild.slug),
      });

      if (!upsertedGuild) continue;

      // Sync guild-server associations
      await this.db.delete(guildServers).where(eq(guildServers.guildId, upsertedGuild.id));

      if (guild.serverAliases.length > 0) {
        // Resolve server aliases to IDs
        const serverRecords = await this.db.query.upstreamServers.findMany({
          where: inArray(upstreamServers.alias, guild.serverAliases),
        });

        const guildServersData = serverRecords.map((server) => ({
          id: crypto.randomUUID(),
          guildId: upsertedGuild.id,
          serverId: server.id,
          addedAt: now,
        }));

        if (guildServersData.length > 0) {
          await this.db.insert(guildServers).values(guildServersData);
        }
      }
    }

    // Remove yaml_managed guilds no longer in config (excluding system guilds)
    const allYamlGuilds = await this.db.query.guilds.findMany({
      where: eq(guilds.yamlManaged, true),
    });

    const guildsToRemove = allYamlGuilds.filter(
      (g) => !yamlGuildSlugs.includes(g.slug)
    );

    if (guildsToRemove.length > 0) {
      await this.db.delete(guilds).where(
        inArray(
          guilds.id,
          guildsToRemove.map((g) => g.id)
        )
      );
    }
  }

  private async syncAgents(config: ResolvedConfig): Promise<void> {
    const now = new Date().toISOString();
    const yamlAgentIds = config.agents.map((a) => a.id);

    // Upsert each agent from YAML
    for (const agent of config.agents) {
      const agentData: InsertAgent = {
        id: agent.id,
        displayName: agent.displayName ?? null,
        clientInfoName: null,
        clientInfoVersion: null,
        lastSeenAt: null,
        sessionCount: 0,
        registrationSource: 'yaml',
        yamlManaged: true,
        createdAt: now,
        updatedAt: now,
      };

      await this.db
        .insert(agents)
        .values(agentData)
        .onConflictDoUpdate({
          target: agents.id,
          set: {
            displayName: agentData.displayName,
            registrationSource: 'yaml',
            yamlManaged: true,
            updatedAt: now,
          },
        });

      // Sync agent-guild associations
      await this.db.delete(agentGuilds).where(eq(agentGuilds.agentId, agent.id));

      if (agent.guildSlugs.length > 0) {
        // Resolve guild slugs to IDs
        const guildRecords = await this.db.query.guilds.findMany({
          where: inArray(guilds.slug, agent.guildSlugs),
        });

        const agentGuildsData = guildRecords.map((guild) => ({
          id: crypto.randomUUID(),
          agentId: agent.id,
          guildId: guild.id,
          addedAt: now,
          addedBy: 'yaml' as const,
          originalAddedAt: null,
        }));

        if (agentGuildsData.length > 0) {
          await this.db.insert(agentGuilds).values(agentGuildsData);
        }
      }

      // Sync agent direct server assignments
      await this.db
        .delete(agentDirectServers)
        .where(eq(agentDirectServers.agentId, agent.id));

      if (agent.directServerAliases.length > 0) {
        // Resolve server aliases to IDs
        const serverRecords = await this.db.query.upstreamServers.findMany({
          where: inArray(upstreamServers.alias, agent.directServerAliases),
        });

        const agentServersData = serverRecords.map((server) => ({
          id: crypto.randomUUID(),
          agentId: agent.id,
          serverId: server.id,
          addedAt: now,
        }));

        if (agentServersData.length > 0) {
          await this.db.insert(agentDirectServers).values(agentServersData);
        }
      }
    }

    // Remove yaml_managed agents no longer in config
    const allYamlAgents = await this.db.query.agents.findMany({
      where: eq(agents.yamlManaged, true),
    });

    const agentsToRemove = allYamlAgents.filter(
      (a) => !yamlAgentIds.includes(a.id)
    );

    if (agentsToRemove.length > 0) {
      await this.db.delete(agents).where(
        inArray(
          agents.id,
          agentsToRemove.map((a) => a.id)
        )
      );
    }
  }
}
