import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('should reject invalid alias formats', () => {
    const invalidAliases = [
      { alias: 'Test', reason: 'uppercase' },
      { alias: '123test', reason: 'starts with number' },
      { alias: 'test_server', reason: 'underscore' },
      { alias: 'test server', reason: 'space' },
    ];

    for (const { alias } of invalidAliases) {
      const yamlContent = `
servers:
  - alias: ${alias}
    name: Test
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
        const errors = (err as ConfigValidationError).errors;
        expect(errors.some((e: string) => e.includes('Invalid alias format'))).toBe(true);
      }
    }
  });

  it('should accept valid alias formats', () => {
    const validAliases = ['test', 'test-server', 'test123', 'a', 'test-123-abc'];

    for (const alias of validAliases) {
      const yamlContent = `
servers:
  - alias: ${alias}
    name: Test
    transport: stdio
    command: node
`;
      fs.writeFileSync(configPath, yamlContent);

      const loader = new YamlConfigLoader(configPath);
      const config = loader.load();

      expect(config.servers[0].alias).toBe(alias);
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
});
