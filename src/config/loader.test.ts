import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { YamlConfigLoader } from './loader.js';
import { ConfigValidationError } from './types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('YamlConfigLoader', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'));
    configPath = path.join(tempDir, 'mcp.yaml');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load valid minimal config', () => {
    const yamlContent = `
port: 4000
servers:
  - alias: test-server
    name: Test Server
    transport: stdio
    command: node
    args: ["test.js"]
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);
    const config = loader.load();

    expect(config.runtime.port).toBe(4000);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].alias).toBe('test-server');
    expect(config.servers[0].transport).toBe('stdio');
  });

  it('should apply default values for missing fields', () => {
    const yamlContent = `
servers:
  - alias: test
    name: Test
    transport: stdio
    command: node
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);
    const config = loader.load();

    expect(config.runtime.port).toBe(4000);
    expect(config.runtime.toolWarnThreshold).toBe(100);
    expect(config.runtime.upstreamConcurrency).toBe(10);
    expect(config.servers[0].enabled).toBe(true);
    expect(config.servers[0].timeoutMs).toBe(30000);
  });

  it('should resolve environment variables in config', () => {
    process.env.TEST_PORT = '5000';
    process.env.TEST_COMMAND = 'test-cmd';

    const yamlContent = `
port: \${TEST_PORT}
servers:
  - alias: test
    name: Test
    transport: stdio
    command: \${TEST_COMMAND}
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);
    const config = loader.load();

    expect(config.runtime.port).toBe(5000);
    expect(config.servers[0].command).toBe('test-cmd');

    delete process.env.TEST_PORT;
    delete process.env.TEST_COMMAND;
  });

  it('should reject duplicate server aliases', () => {
    const yamlContent = `
servers:
  - alias: test
    name: Test 1
    transport: stdio
    command: node
  - alias: test
    name: Test 2
    transport: stdio
    command: node
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);

    expect(() => loader.load()).toThrow(ConfigValidationError);
    try {
      loader.load();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).errors).toContain('Duplicate server alias: test');
    }
  });

  it('should reject duplicate guild slugs', () => {
    const yamlContent = `
servers:
  - alias: s1
    name: Server 1
    transport: stdio
    command: node
guilds:
  - slug: my-guild
    name: Guild 1
  - slug: my-guild
    name: Guild 2
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);

    expect(() => loader.load()).toThrow(ConfigValidationError);
    try {
      loader.load();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).errors).toContain('Duplicate guild slug: my-guild');
    }
  });

  it('should validate config without loading', () => {
    const yamlContent = `
servers:
  - alias: test
    name: Test
    transport: stdio
    command: node
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);
    const result = loader.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should return validation errors for invalid config', () => {
    const yamlContent = `
servers:
  - name: Missing Alias
    transport: stdio
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);
    const result = loader.validate();

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should reject symlink config files', () => {
    const realConfigPath = path.join(tempDir, 'real-config.yaml');
    const symlinkPath = path.join(tempDir, 'symlink-config.yaml');

    fs.writeFileSync(realConfigPath, 'port: 4000\nservers: []');
    fs.symlinkSync(realConfigPath, symlinkPath);

    const loader = new YamlConfigLoader(symlinkPath);

    expect(() => loader.load()).toThrow(ConfigValidationError);
    expect(() => loader.load()).toThrow(/Symlink detected/);
  });

  it('should load guilds and agents from config', () => {
    const yamlContent = `
servers:
  - alias: s1
    name: Server 1
    transport: stdio
    command: node
guilds:
  - slug: engineering
    name: Engineering
    color: "#ef4444"
    servers: ["s1"]
agents:
  - id: agent-123
    display_name: Test Agent
    guilds: ["engineering"]
    direct_servers: ["s1"]
`;
    fs.writeFileSync(configPath, yamlContent);

    const loader = new YamlConfigLoader(configPath);
    const config = loader.load();

    expect(config.guilds).toHaveLength(1);
    expect(config.guilds[0].slug).toBe('engineering');
    expect(config.guilds[0].color).toBe('#ef4444');
    expect(config.guilds[0].serverAliases).toEqual(['s1']);

    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe('agent-123');
    expect(config.agents[0].guildSlugs).toEqual(['engineering']);
    expect(config.agents[0].directServerAliases).toEqual(['s1']);
  });

  describe('watch() error handling', () => {
    it('should call onError callback when config reload fails', async () => {
      // Regression test for PAP-51: Config reload failures should be propagated via onError callback
      const yamlContent = `
servers:
  - alias: test
    name: Test
    transport: stdio
    command: node
`;
      fs.writeFileSync(configPath, yamlContent);

      const loader = new YamlConfigLoader(configPath);

      let errorCaught: Error | null = null;
      let changeCount = 0;

      const stopWatching = loader.watch(
        (next, prev) => {
          changeCount++;
        },
        (error) => {
          errorCaught = error;
        }
      );

      // Wait a bit for watcher to be ready
      await new Promise(resolve => setTimeout(resolve, 100));

      // Write invalid YAML to trigger reload error
      fs.writeFileSync(configPath, 'invalid: yaml: content: [unclosed');

      // Wait for file watcher to trigger
      await new Promise(resolve => setTimeout(resolve, 200));

      stopWatching();

      // Should have called onError with the error
      expect(errorCaught).not.toBeNull();
      expect(errorCaught).toBeInstanceOf(Error);
      // Should not have called onChange (reload failed)
      expect(changeCount).toBe(0);
    });

    it('should log to console when onError not provided (backward compatibility)', async () => {
      const yamlContent = `
servers:
  - alias: test
    name: Test
    transport: stdio
    command: node
`;
      fs.writeFileSync(configPath, yamlContent);

      const loader = new YamlConfigLoader(configPath);

      let changeCount = 0;
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const stopWatching = loader.watch((next, prev) => {
        changeCount++;
      });

      // Wait a bit for watcher to be ready
      await new Promise(resolve => setTimeout(resolve, 100));

      // Write invalid YAML to trigger reload error
      fs.writeFileSync(configPath, 'invalid: [unclosed');

      // Wait for file watcher to trigger
      await new Promise(resolve => setTimeout(resolve, 200));

      stopWatching();

      // Should have logged error to console (backward compatibility)
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('Config reload failed');

      consoleErrorSpy.mockRestore();
    });

    it('should preserve previous config when reload fails', async () => {
      // Regression test for PAP-51: When reload fails, previous valid config should remain accessible
      const validYaml = `
servers:
  - alias: test
    name: Test Server
    transport: stdio
    command: node
`;
      fs.writeFileSync(configPath, validYaml);

      const loader = new YamlConfigLoader(configPath);

      let lastSuccessfulConfig: any = null;
      let errorsCaught: Error[] = [];

      const stopWatching = loader.watch(
        (next, prev) => {
          lastSuccessfulConfig = next;
        },
        (error) => {
          errorsCaught.push(error);
        }
      );

      // Wait for watcher to be ready
      await new Promise(resolve => setTimeout(resolve, 100));

      // Write invalid config - should trigger onError, not onChange
      fs.writeFileSync(configPath, 'servers: [invalid yaml structure');
      await new Promise(resolve => setTimeout(resolve, 300));

      stopWatching();

      // Error callback should have been called
      expect(errorsCaught.length).toBeGreaterThanOrEqual(1);
      expect(errorsCaught[0]).toBeInstanceOf(Error);

      // No successful reload should have happened (lastSuccessfulConfig stays null since we only wrote invalid config)
      expect(lastSuccessfulConfig).toBeNull();
    });
  });
});
