#!/usr/bin/env node

import { Command } from 'commander';
import { YamlConfigLoader } from '../src/config/loader.js';
import { createDb } from '../src/db/client.js';
import { SqliteConfigStore } from '../src/db/config-store.js';
import { AggregatorEngine } from '../src/aggregator/engine.js';
import { runMigrations } from '../src/db/migrate.js';
import * as path from 'node:path';
import * as os from 'node:os';

const program = new Command();

program
  .name('mcp-aggregator')
  .description('MCP Aggregator Proxy - route and aggregate MCP tool servers')
  .version('0.1.0');

// Start command
program
  .command('start')
  .description('Start the MCP aggregator server')
  .option('--port <port>', 'HTTP port', '4000')
  .option('--bind <address>', 'Bind address', '127.0.0.1')
  .option('--home <path>', 'Home directory for config and database', () => {
    return path.join(os.homedir(), '.mcp-aggregator');
  })
  .option('--public-url <url>', 'Public URL for the server', 'http://localhost:4000')
  .action(async (options) => {
    try {
      const homePath = options.home;
      const port = parseInt(options.port, 10);

      console.log(`Starting MCP Aggregator...`);
      console.log(`Home: ${homePath}`);
      console.log(`Port: ${port}`);
      console.log(`Bind: ${options.bind}`);

      // Initialize database
      const dbPath = path.join(homePath, 'mcp-aggregator.db');
      const db = createDb(dbPath);

      // Run migrations
      console.log('Running database migrations...');
      await runMigrations(dbPath);

      // Initialize config store
      const store = new SqliteConfigStore(db);

      // Load configuration
      const configPath = path.join(homePath, 'mcp.yaml');
      const configLoader = new YamlConfigLoader(configPath);
      const config = await configLoader.load();

      console.log(`Loaded configuration: ${config.servers.length} servers configured`);

      // Sync config to database
      await store.syncConfig(config);

      // Initialize aggregator engine
      const engine = new AggregatorEngine();

      console.log('MCP Aggregator started successfully');
      console.log(`Listening on http://${options.bind}:${port}/mcp`);

      // TODO: Start HTTP server with MCP handler
      // For now, just keep process alive
      process.on('SIGTERM', async () => {
        console.log('SIGTERM received, shutting down gracefully...');
        // TODO: Close engine, close HTTP server
        process.exit(0);
      });

      process.on('SIGINT', async () => {
        console.log('SIGINT received, shutting down gracefully...');
        // TODO: Close engine, close HTTP server
        process.exit(0);
      });

      // Keep process alive
      await new Promise(() => {});
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  });

// Validate command
program
  .command('validate')
  .description('Validate configuration file')
  .option('--home <path>', 'Home directory for config', () => {
    return path.join(os.homedir(), '.mcp-aggregator');
  })
  .action(async (options) => {
    try {
      const homePath = options.home;
      const configPath = path.join(homePath, 'mcp.yaml');

      console.log(`Validating configuration: ${configPath}`);

      const configLoader = new YamlConfigLoader(configPath);
      const config = await configLoader.load();

      console.log('✓ Configuration is valid');
      console.log(`  Servers: ${config.servers.length}`);
      console.log(`  Guilds: ${config.guilds.length}`);
      console.log(`  Agents: ${config.agents.length}`);

      process.exit(0);
    } catch (error) {
      console.error('✗ Configuration validation failed:');
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Migrate command
program
  .command('migrate')
  .description('Run database migrations')
  .option('--home <path>', 'Home directory for database', () => {
    return path.join(os.homedir(), '.mcp-aggregator');
  })
  .action(async (options) => {
    try {
      const homePath = options.home;
      const dbPath = path.join(homePath, 'mcp-aggregator.db');

      console.log(`Running migrations on: ${dbPath}`);

      await runMigrations(dbPath);

      console.log('✓ Migrations completed successfully');
      process.exit(0);
    } catch (error) {
      console.error('✗ Migration failed:');
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
