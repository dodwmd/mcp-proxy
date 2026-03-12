CREATE TABLE `agent_direct_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`server_id` text NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `upstream_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_direct_servers_agent_id_server_id_unique` ON `agent_direct_servers` (`agent_id`,`server_id`);--> statement-breakpoint
CREATE TABLE `agent_guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`added_at` text NOT NULL,
	`added_by` text DEFAULT 'api' NOT NULL,
	`original_added_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_guilds_agent_id_guild_id_unique` ON `agent_guilds` (`agent_id`,`guild_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`client_info_name` text,
	`client_info_version` text,
	`last_seen_at` text,
	`session_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`registration_source` text DEFAULT 'auto' NOT NULL,
	`yaml_managed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`target_id` text NOT NULL,
	`target_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_log_created_at_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor`);--> statement-breakpoint
CREATE TABLE `guild_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`server_id` text NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`guild_id`) REFERENCES `guilds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `upstream_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guild_servers_guild_id_server_id_unique` ON `guild_servers` (`guild_id`,`server_id`);--> statement-breakpoint
CREATE TABLE `guilds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`color` text DEFAULT '#6366f1' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`yaml_managed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guilds_slug_unique` ON `guilds` (`slug`);--> statement-breakpoint
CREATE TABLE `idempotency_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`key` text NOT NULL,
	`response_body` text,
	`response_status` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idempotency_cache_expires_at_idx` ON `idempotency_cache` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_cache_method_path_key_unique` ON `idempotency_cache` (`method`,`path`,`key`);--> statement-breakpoint
CREATE TABLE `server_tool_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_description` text,
	`input_schema` text,
	`cached_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `upstream_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_tool_cache_server_id_tool_name_unique` ON `server_tool_cache` (`server_id`,`tool_name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`guild_slugs` text,
	`connected_at` text NOT NULL,
	`disconnected_at` text,
	`client_info` text,
	`upstream_statuses` text,
	`tool_count` integer DEFAULT 0 NOT NULL,
	`port` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `upstream_env_vars` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `upstream_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `upstream_headers` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `upstream_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `upstream_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`alias` text NOT NULL,
	`transport_type` text NOT NULL,
	`command` text,
	`args` text,
	`url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`timeout_ms` integer DEFAULT 30000 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_connected_at` text,
	`last_error_at` text,
	`last_error_message` text,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`cached_tool_count` integer DEFAULT 0 NOT NULL,
	`yaml_managed` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upstream_servers_alias_unique` ON `upstream_servers` (`alias`);