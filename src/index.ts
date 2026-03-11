/**
 * MCP Aggregator entry point
 * M0: Scaffold only - core functionality in M1+
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json to stay in sync with Changesets updates
function getVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

export const version = getVersion();
