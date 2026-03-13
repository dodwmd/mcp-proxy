import { warn } from '../utils/logger.js';

/**
 * Resolves environment variable placeholders in strings.
 * Format: ${VAR_NAME} or ${VAR_NAME:-default}
 * Logs warnings for unresolved variables without defaults.
 */
export function resolveEnvVars(template: string): string {
  return template.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, varName, defaultValue) => {
    const value = process.env[varName];

    if (value !== undefined) {
      return value;
    }

    if (defaultValue !== undefined) {
      return defaultValue;
    }

    warn({ var_name: varName }, 'Environment variable not set, using empty string');
    return '';
  });
}

/**
 * Recursively resolves env vars in an object's string values.
 */
export function resolveEnvVarsInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return resolveEnvVars(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVarsInObject(item)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveEnvVarsInObject(value);
    }
    return resolved as T;
  }

  return obj;
}
