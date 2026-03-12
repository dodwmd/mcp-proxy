#!/usr/bin/env node

import { Command } from 'commander';
import { YamlConfigLoader } from '../src/config/loader.js';
import { createDbClient } from '../src/db/client.js';
import { SqliteConfigStore } from '../src/db/config-store.js';
import { AggregatorEngine } from '../src/aggregator/engine.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createMcpServer,
  createStreamableHttpTransport,
  createHttpServer,
  startHttpServer,
} from '../src/server/index.js';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_HOME = path.join(os.homedir(), '.mcp-aggregator');

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
  .option('--home <path>', 'Home directory for config and database', DEFAULT_HOME)
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
      const { db } = await createDbClient(dbPath);

      // Run migrations
      console.log('Running database migrations...');
      await runMigrations({ dbPath });

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

      // Get resolved server configs from the config store
      // For M1, we use all servers from the config
      const serverConfigs = config.servers.map(s => ({
        id: s.alias,
        name: s.name,
        alias: s.alias,
        transportType: s.transport.type,
        command: s.transport.type === 'stdio' ? s.transport.command : undefined,
        args: s.transport.type === 'stdio' ? s.transport.args : undefined,
        url: s.transport.type !== 'stdio' ? s.transport.url : undefined,
        enabled: true,
        timeoutMs: s.transport.timeoutMs ?? 30000,
        env: s.env ?? {},
        headers: s.headers ?? {},
      }));

      // Create MCP server
      const mcpServer = createMcpServer({
        engine,
        serverConfigs,
        serverInfo: {
          name: 'mcp-aggregator',
          version: '0.1.0',
        },
      });

      // Create StreamableHTTP transport
      const transport = createStreamableHttpTransport();

      // Create HTTP server (connects MCP server to transport)
      const app = await createHttpServer({
        port,
        bind: options.bind,
        mcpServer,
        transport,
      });

      // Start HTTP server
      const httpServer = await startHttpServer(app, port, options.bind);

      console.log('MCP Aggregator started successfully');

      // Graceful shutdown handlers
      const shutdown = async () => {
        console.log('Shutting down gracefully...');
        try {
          await httpServer.close();
          // Allow time for MCP server onclose cleanup to complete before process exit
          // The onclose handler triggers asynchronous session cleanup that must complete
          // to avoid resource leaks (file descriptors, database connections, etc.)
          console.log('Waiting for session cleanup to complete...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          console.log('Shutdown complete');
          process.exit(process.exitCode ?? 0);
        } catch (err) {
          console.error('Error during shutdown:', err);
          process.exit(1);
        }
      };

      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);

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
  .option('--home <path>', 'Home directory for config', DEFAULT_HOME)
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
  .option('--home <path>', 'Home directory for database', DEFAULT_HOME)
  .action(async (options) => {
    try {
      const homePath = options.home;
      const dbPath = path.join(homePath, 'mcp-aggregator.db');

      console.log(`Running migrations on: ${dbPath}`);

      await runMigrations({ dbPath });

      console.log('✓ Migrations completed successfully');
      process.exit(0);
    } catch (error) {
      console.error('✗ Migration failed:');
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
