import pino from 'pino';

/**
 * Context fields for structured logging.
 * All fields are optional and should be added based on operation context.
 */
export interface LogContext {
  session_id?: string;
  agent_id?: string;
  alias?: string;
  req_id?: string;
  duration_ms?: number;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * Structured logger singleton using Pino.
 *
 * Configuration:
 * - LOG_LEVEL: Set log level (trace, debug, info, warn, error, fatal). Default: info
 * - NODE_ENV: When set to 'production', outputs NDJSON. Otherwise uses pino-pretty for human-readable output.
 *
 * Log format matches spec §16.8: Structured Logging Format
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',

  // Base fields included in every log entry
  base: {
    service: 'mcp-aggregator',
    pid: process.pid,
  },

  // Pretty print in development, NDJSON in production
  transport: process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,

  // Timestamp as ISO 8601 (spec requires 'ts' field)
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,

  // Error serialization
  serializers: {
    error: pino.stdSerializers.err,
  },

  // Redact sensitive fields (never log env values or headers)
  redact: {
    paths: ['env', 'headers', '*.env', '*.headers'],
    remove: true,
  },
});

/**
 * Re-export logger methods for convenience.
 * Usage: import { info, error } from './utils/logger.js';
 */
export const { trace, debug, info, warn, error, fatal } = logger;
