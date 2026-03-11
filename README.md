# mcp-aggregator

MCP (Model Context Protocol) aggregator proxy for managing multiple MCP servers with agent-specific routing and guild-based access control.

## Status

**Milestone 0 (M0)**: ✅ Project scaffold complete
**Milestone 1 (M1)**: 🔜 Core MCP server functionality
**Milestone 2 (M2)**: 🔜 Agent/guild routing
**Milestone 3 (M3)**: 🔜 REST API
**Milestone 4 (M4)**: 🔜 Observability
**Milestone 5 (M5)**: 🔜 Web UI

Current features: Development tooling, testing framework, CI/CD pipeline, Docker support.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 9+

### Installation

```bash
# Clone repository
git clone https://github.com/dodwmd/mcp-proxy.git
cd mcp-proxy

# Install dependencies
pnpm install

# Run development server (M0: stub only)
pnpm dev
```

### NPX (Future)

```bash
npx mcp-aggregator start
```

### Docker

```bash
# Build and run
docker compose up

# Or build manually
docker build -t mcp-aggregator .
docker run -p 4000:4000 -v $(pwd)/mcp.yaml:/app/mcp.yaml:ro mcp-aggregator
```

## Development

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Run tests
pnpm test          # Watch mode
pnpm test:run      # Single run
pnpm test:coverage # With coverage

# Type checking
pnpm typecheck

# Linting
pnpm lint          # Check
pnpm lint:fix      # Fix

# Build
pnpm build

# Database (M1+)
pnpm db:generate   # Generate migrations
pnpm db:migrate    # Apply migrations
pnpm db:studio     # Open Drizzle Studio
```

## Configuration

Create `mcp.yaml` in your working directory (will be used in M1+):

```yaml
# Example configuration (non-functional in M0)
servers:
  - name: filesystem
    command: npx
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/files']
    env:
      LOG_LEVEL: info

  - name: github
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: ${GITHUB_TOKEN}

guilds:
  - name: web-team
    servers: [filesystem, github]

agents:
  - name: claudecoder
    agentId: claude-dev-001
    guild: web-team
```

**⚠️ WARNING**: Add `mcp.yaml` to `.gitignore` (already configured). Never commit secrets or API keys.

## Claude Code/Desktop Integration

### Claude Code

Add to your workspace MCP settings:

```json
{
  "mcpServers": {
    "mcp-aggregator": {
      "command": "node",
      "args": ["/path/to/mcp-proxy/dist/index.js", "start"],
      "env": {
        "MCP_CONFIG": "/path/to/mcp.yaml"
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-aggregator": {
      "command": "npx",
      "args": ["mcp-aggregator", "start"]
    }
  }
}
```

## Project Structure

```
mcp-proxy/
├── src/                  # Source code
│   ├── db/              # Database schema (M1+)
│   └── index.ts         # Entry point
├── tests/               # Integration tests (M2+)
├── ui/                  # Web UI (M5)
├── drizzle/             # Database migrations
├── dist/                # Build output
├── .github/workflows/   # CI/CD pipelines
├── docker-compose.yml   # Development environment
├── Dockerfile           # Production container
└── SPEC.md             # Full specification

```

## Scripts Reference

| Script               | Description                               |
| -------------------- | ----------------------------------------- |
| `pnpm dev`           | Run development server with hot reload    |
| `pnpm build`         | Compile TypeScript to JavaScript          |
| `pnpm typecheck`     | Run TypeScript compiler without emitting  |
| `pnpm lint`          | Check code style with ESLint and Prettier |
| `pnpm lint:fix`      | Auto-fix linting issues                   |
| `pnpm test`          | Run tests in watch mode                   |
| `pnpm test:run`      | Run tests once                            |
| `pnpm test:coverage` | Run tests with coverage report            |
| `pnpm db:generate`   | Generate Drizzle migrations from schema   |
| `pnpm db:migrate`    | Apply pending migrations                  |
| `pnpm db:studio`     | Open Drizzle Studio (database GUI)        |

## Acceptance Criteria (M0)

- ✅ Repository builds successfully (`pnpm build` exits 0)
- ✅ All tests pass (`pnpm test:run` exits 0)
- ✅ Linting passes (`pnpm lint` exits 0)
- ✅ Type checking passes (`pnpm typecheck` exits 0)
- ✅ GitHub Actions CI workflow runs and passes
- ✅ Docker image builds successfully
- ✅ README includes quickstart and integration snippets
- ✅ Conventional Commits enforced via Husky

## Troubleshooting

### "Agent shows 0 tools"

This feature is implemented in M2 (agent/guild routing). In M0, the scaffold is non-functional.

### Docker build fails

Ensure you have pnpm lockfile:

```bash
pnpm install
```

### CI fails on GitHub Actions

Check that all dependencies are in `package.json` and `pnpm-lock.yaml` is committed.

### Husky hooks not running

Initialize Husky after cloning:

```bash
pnpm install  # Runs prepare script automatically
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes following the project conventions
4. Add tests for new functionality
5. Ensure all checks pass (`pnpm typecheck && pnpm lint && pnpm test:run`)
6. Create a changeset: `pnpm changeset`
7. Commit using Conventional Commits format
8. Push and create a Pull Request

## Versioning

This project uses [Changesets](https://github.com/changesets/changesets) for version management. See [.changeset/README.md](.changeset/README.md) for details.

## License

MIT

## Specification

See [SPEC.md](./SPEC.md) for the complete project specification including all milestones and requirements.
