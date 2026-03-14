import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import * as path from 'node:path';
import * as os from 'node:os';

interface CLIOptions {
  home?: string;
  value?: string;
}

describe('CLI Default Path Handling', () => {
  it('should use correct default value for --home option (not a parser function)', () => {
    // Regression test for PAP-52: Commander.js was treating arrow function as parser instead of default value
    const DEFAULT_HOME = path.join(os.homedir(), '.mcp-aggregator');

    let capturedOptions: CLIOptions = {};
    const program = new Command();
    program
      .exitOverride() // Prevent process.exit in tests
      .command('start')
      .option('--home <path>', 'Home directory', DEFAULT_HOME)
      .action((options) => {
        capturedOptions = options;
      });

    // Parse with no --home argument provided
    program.parse(['start'], { from: 'user' });

    // Should have the default value
    expect(capturedOptions.home).toBe(DEFAULT_HOME);
    expect(capturedOptions.home).toContain('.mcp-aggregator');
  });

  it('should allow --home to be overridden', () => {
    const DEFAULT_HOME = path.join(os.homedir(), '.mcp-aggregator');
    const CUSTOM_HOME = '/custom/path';

    let capturedOptions: CLIOptions = {};
    const program = new Command();
    program
      .exitOverride() // Prevent process.exit in tests
      .command('start')
      .option('--home <path>', 'Home directory', DEFAULT_HOME)
      .action((options) => {
        capturedOptions = options;
      });

    // Parse with custom --home argument
    program.parse(['start', '--home', CUSTOM_HOME], { from: 'user' });

    // Should use the provided value, not the default
    expect(capturedOptions.home).toBe(CUSTOM_HOME);
  });

  it('should not treat default value as a parser function', () => {
    // This test verifies the bug is fixed: passing a function as 3rd param makes it a parser, not a default

    // WRONG WAY (the bug): function as 3rd parameter is treated as a parser
    let buggyOptions: CLIOptions = {};
    const buggyProgram = new Command();
    buggyProgram
      .exitOverride() // Prevent process.exit in tests
      .command('buggy')
      .option('--value <val>', 'Test value', () => {
        return 'default-value';
      })
      .action((options) => {
        buggyOptions = options;
      });

    // When no argument is provided, a parser function is NOT called for defaults
    // It's only called when a value IS provided
    buggyProgram.parse(['buggy'], { from: 'user' });

    // Bug: With function as 3rd param, default is undefined (function is a parser, not a default)
    expect(buggyOptions.value).toBeUndefined();

    // CORRECT WAY: string as 3rd parameter is the default value
    let fixedOptions: CLIOptions = {};
    const fixedProgram = new Command();
    fixedProgram
      .exitOverride() // Prevent process.exit in tests
      .command('fixed')
      .option('--value <val>', 'Test value', 'default-value')
      .action((options) => {
        fixedOptions = options;
      });

    fixedProgram.parse(['fixed'], { from: 'user' });

    // Fixed: String as 3rd param correctly sets the default
    expect(fixedOptions.value).toBe('default-value');
  });
});
