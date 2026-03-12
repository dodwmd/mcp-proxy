import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

// Upstream MCP servers
export const upstreamServers = sqliteTable('upstream_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  alias: text('alias').notNull().unique(),
  transportType: text('transport_type', { enum: ['stdio', 'streamablehttp', 'sse'] }).notNull(),
  command: text('command'),
  args: text('args', { mode: 'json' }).$type<string[]>(),
  url: text('url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  timeoutMs: integer('timeout_ms').notNull().default(30000),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastConnectedAt: text('last_connected_at'),
  lastErrorAt: text('last_error_at'),
  lastErrorMessage: text('last_error_message'),
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  cachedToolCount: integer('cached_tool_count').notNull().default(0),
  yamlManaged: integer('yaml_managed', { mode: 'boolean' }).notNull().default(false),
});

export const upstreamEnvVars = sqliteTable('upstream_env_vars', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => upstreamServers.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const upstreamHeaders = sqliteTable('upstream_headers', {
  id: text('id').primaryKey(),
  serverId: text('server_id')
    .notNull()
    .references(() => upstreamServers.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Guilds
export const guilds = sqliteTable('guilds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  color: text('color').notNull().default('#6366f1'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  yamlManaged: integer('yaml_managed', { mode: 'boolean' }).notNull().default(false),
});

// Guild-Server many-to-many
export const guildServers = sqliteTable(
  'guild_servers',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => upstreamServers.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull(),
  },
  (t) => ({
    uniqGuildServer: unique().on(t.guildId, t.serverId),
  })
);

// Agents
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  clientInfoName: text('client_info_name'),
  clientInfoVersion: text('client_info_version'),
  lastSeenAt: text('last_seen_at'),
  sessionCount: integer('session_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  registrationSource: text('registration_source', {
    enum: ['auto', 'yaml', 'api'],
  })
    .notNull()
    .default('auto'),
  yamlManaged: integer('yaml_managed', { mode: 'boolean' }).notNull().default(false),
});

// Agent-Guild many-to-many
export const agentGuilds = sqliteTable(
  'agent_guilds',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull(),
    addedBy: text('added_by', { enum: ['yaml', 'api', 'hint'] })
      .notNull()
      .default('api'),
    originalAddedAt: text('original_added_at'),
  },
  (t) => ({
    uniqAgentGuild: unique().on(t.agentId, t.guildId),
  })
);

// Agent direct server assignments
export const agentDirectServers = sqliteTable(
  'agent_direct_servers',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => upstreamServers.id, { onDelete: 'cascade' }),
    addedAt: text('added_at').notNull(),
  },
  (t) => ({
    uniqAgentServer: unique().on(t.agentId, t.serverId),
  })
);

// Sessions
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  guildSlugs: text('guild_slugs', { mode: 'json' }).$type<string[]>(),
  connectedAt: text('connected_at').notNull(),
  disconnectedAt: text('disconnected_at'),
  clientInfo: text('client_info', { mode: 'json' }).$type<Record<string, unknown>>(),
  upstreamStatuses: text('upstream_statuses', { mode: 'json' }).$type<
    Record<string, 'connected' | 'error' | 'skipped'>
  >(),
  toolCount: integer('tool_count').notNull().default(0),
  port: integer('port'),
});

// Server tool cache
export const serverToolCache = sqliteTable(
  'server_tool_cache',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => upstreamServers.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    toolDescription: text('tool_description'),
    inputSchema: text('input_schema', { mode: 'json' }).$type<Record<string, unknown>>(),
    cachedAt: text('cached_at').notNull(),
  },
  (t) => ({
    uniqServerTool: unique().on(t.serverId, t.toolName),
  })
);

// Audit log
export type AuditPayload = {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  keys_updated?: string[];
  reason?: string;
};

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(),
    actor: text('actor').notNull(),
    targetId: text('target_id').notNull(),
    targetType: text('target_type', { enum: ['agent', 'guild', 'server', 'session'] }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<AuditPayload>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    targetIdx: index('audit_log_target_idx').on(t.targetType, t.targetId),
    createdAtIdx: index('audit_log_created_at_idx').on(t.createdAt),
    actorIdx: index('audit_log_actor_idx').on(t.actor),
  })
);

// Idempotency cache
export const idempotencyCache = sqliteTable(
  'idempotency_cache',
  {
    id: text('id').primaryKey(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    key: text('key').notNull(),
    responseBody: text('response_body', { mode: 'json' }).$type<Record<string, unknown>>(),
    responseStatus: integer('response_status').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    uniqMethodPathKey: unique().on(t.method, t.path, t.key),
    expiresAtIdx: index('idempotency_cache_expires_at_idx').on(t.expiresAt),
  })
);

// Relations
export const upstreamServersRelations = relations(upstreamServers, ({ many }) => ({
  envVars: many(upstreamEnvVars),
  headers: many(upstreamHeaders),
  guildServers: many(guildServers),
  agentDirectServers: many(agentDirectServers),
  toolCache: many(serverToolCache),
}));

export const guildsRelations = relations(guilds, ({ many }) => ({
  guildServers: many(guildServers),
  agentGuilds: many(agentGuilds),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  agentGuilds: many(agentGuilds),
  agentDirectServers: many(agentDirectServers),
  sessions: many(sessions),
}));

export const guildServersRelations = relations(guildServers, ({ one }) => ({
  guild: one(guilds, {
    fields: [guildServers.guildId],
    references: [guilds.id],
  }),
  server: one(upstreamServers, {
    fields: [guildServers.serverId],
    references: [upstreamServers.id],
  }),
}));

export const agentGuildsRelations = relations(agentGuilds, ({ one }) => ({
  agent: one(agents, {
    fields: [agentGuilds.agentId],
    references: [agents.id],
  }),
  guild: one(guilds, {
    fields: [agentGuilds.guildId],
    references: [guilds.id],
  }),
}));

// Type exports
export type UpstreamServer = typeof upstreamServers.$inferSelect;
export type InsertUpstreamServer = typeof upstreamServers.$inferInsert;
export type Guild = typeof guilds.$inferSelect;
export type InsertGuild = typeof guilds.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type InsertSession = typeof sessions.$inferInsert;
export type ServerToolCacheEntry = typeof serverToolCache.$inferSelect;
export type InsertServerToolCacheEntry = typeof serverToolCache.$inferInsert;
