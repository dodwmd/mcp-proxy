# MCP Aggregator Proxy — Specification

## 1. Problem Statement

MCP servers are configured statically in agent config files. Adding a new MCP tool server requires editing that config and restarting every affected agent. For teams running many agents, this is operationally painful.

Additionally, different agents need different tool sets — a QA bot shouldn't have access to deployment tools; a DevOps bot shouldn't have access to design tools. Today there's no easy way to manage this without maintaining N separate MCP configs.

**Goals:**

1. Each agent has a single, stable MCP URL that never changes
2. Operators manage MCP server assignments at runtime via a web UI — no agent restarts or config edits required
3. Agents can be grouped into **guilds** — named bundles of MCP servers — so assigning a role to an agent gives it the right tools automatically
4. An agent can belong to **multiple guilds** simultaneously — e.g. "garry" gets both the `ceo` and `developer` guild tools
5. An agent can also have **individual MCP servers** assigned on top of its guilds — for one-off overrides specific to that agent
6. The web UI shows every agent: who's connected, what guilds they're in, what tools they have access to

---

## 2. Core Concepts

### Upstream MCP Server

An external MCP server the aggregator connects to (e.g. GitHub tools, filesystem, browser automation). Can be stdio (subprocess) or HTTP.

### Guild

A named, reusable bundle of upstream MCP servers. Examples: `qa-engineer`, `devops`, `frontend`, `ceo`. A guild is a role — assign it to an agent to give that agent all tools for that role.

### Agent

A registered entity (a Claude Code instance, an automated bot, etc.) with a stable, unique endpoint URL. An agent can belong to **multiple guilds** — its tool set is the union of all guild tools plus any directly assigned servers. Two agents in the same guild (e.g. `garry` and `claire`, both in `ceo`) can have different direct-assigned servers on top.

### Relationship model

```
Upstream MCP Server (n) ────────────── belongs to (many) ─────────── Guild (m)
                                                                          │
                          ┌───────────────────────────────────────────────┤
                          │  agent_guilds (join table, many-to-many)      │
                          └───────────────────────────────────────────────┤
                                                                          ▼
                    agent_direct_servers ──────────────────────────── Agent (n)
                    (one-off extras per agent)                            │
                                                                          ▼
                                                         /mcp/agents/:agent-id
                                                         ← stable URL in agent config
```

**Tool resolution for an agent:**

```
tools = union( guild_servers(g) for g in agent.guilds ) ∪ agent_direct_servers(agent.id)
```

Deduplication: if the same upstream server appears in multiple guilds or also as a direct assignment, it is connected once and its tools appear once.

---

## 3. Solution Overview

The service runs on a **single port** (default `:4000`). MCP endpoints are served under `/mcp/*`, the REST API under `/api/*`, and the web UI at `/`. This avoids the operational overhead of two separate ports and simplifies reverse-proxy configuration.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Agents                                                               │
│  claude-qa-1  →  http://localhost:4000/mcp/agents/claude-qa-1        │
│  claude-qa-2  →  http://localhost:4000/mcp/agents/claude-qa-2        │
│  claude-ops-1 →  http://localhost:4000/mcp/agents/claude-ops-1       │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  MCP (Streamable HTTP)
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        mcp-aggregator  (:4000)                        │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Agent Router  (/mcp/agents/:id  →  resolve guild → serve MCPs) │ │
│  └───────────────────────────┬─────────────────────────────────────┘ │
│                              │                                        │
│  ┌────────────────┐   ┌──────▼────────┐   ┌────────────────────────┐ │
│  │  Aggregator    │◄──│  Guild/Agent  │   │  Web UI (/*)           │ │
│  │  Engine        │   │  Resolver     │   │  REST API (/api/*)     │ │
│  └───────┬────────┘   └───────────────┘   └────────────────────────┘ │
│          │                                                            │
│  ┌───────▼────────────────────────────────────────────────────────┐  │
│  │                    Config Store (SQLite)                        │  │
│  │  agents  ·  guilds  ·  guild_servers  ·  agent_direct_servers  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
         │                    │                    │
   ┌─────▼──────┐      ┌──────▼──────┐      ┌──────▼──────┐
   │ qa guild   │      │ devops guild│      │ (direct)    │
   │ - browser  │      │ - k8s       │      │ - custom    │
   │ - github   │      │ - github    │      │   server    │
   │ - slack    │      │ - terraform │      └─────────────┘
   └────────────┘      └─────────────┘
```

**Port configuration:** Default port is `4000`, overridable via `MCP_AGGREGATOR_PORT`. The `--port` CLI flag also sets this.

**Two-port layout (optional):** Setting `MCP_AGGREGATOR_API_PORT` starts a **second** HTTP listener on that port serving `/api/*` and `/` (web UI). The primary port (`MCP_AGGREGATOR_PORT`) serves `/mcp/*` plus `/health` (the `GET /health` system endpoint), so liveness and readiness probes work on the primary port regardless of layout. All other `/api/*` routes and the web UI are served only on the API port. Use this when a reverse proxy needs to route MCP and management traffic to different backends.

**Public URL:** `MCP_AGGREGATOR_PUBLIC_URL` sets the base URL the proxy advertises to agents in `initialize` instructions and to the web UI for link generation (e.g. `https://mcp.example.com`). Defaults to `http://localhost:{port}`. Must be set when running behind a reverse proxy.

---

## 3.1 Configuration

### YAML config file — source of truth

The primary operator interface is a single YAML file at `$MCP_AGGREGATOR_HOME/mcp.yaml` (default `~/.mcp-aggregator/mcp.yaml`). This file defines servers, guilds, and agent assignments. Editing it and saving triggers a live reload with no restart required (see §8).

```yaml
# ~/.mcp-aggregator/mcp.yaml

# Runtime settings (all optional — also settable via CLI flag or env var)
port: 4000
publicUrl: 'http://localhost:4000'

# Upstream MCP server definitions
servers:
  - alias: github
    name: GitHub Tools
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' # env var interpolation
    timeout_ms: 30000

  - alias: browser
    name: Browser Automation
    transport: streamablehttp
    url: http://localhost:3001/mcp
    headers:
      Authorization: 'Bearer ${BROWSER_TOKEN}'

  - alias: slack
    name: Slack
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-slack']
    env:
      SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}'

  - alias: garry-crm
    name: Garry Custom CRM
    transport: streamablehttp
    url: http://localhost:3002/mcp
    headers:
      Authorization: 'Bearer ${GARRY_CRM_TOKEN}'

# Guild definitions — named bundles of servers
guilds:
  - slug: qa-engineer
    name: QA Engineer
    color: '#10b981'
    description: Tools for QA testing workflows
    servers: [browser, github, slack]

  - slug: developer
    name: Developer
    color: '#3b82f6'
    servers: [github]

  - slug: ceo
    name: CEO
    color: '#8b5cf6'
    servers: [browser, slack]

# Agent pre-configuration (optional).
# Agents NOT listed here auto-register on first connect with no guilds.
agents:
  - id: garry
    display_name: 'Garry (CEO agent)'
    guilds: [ceo, developer]
    direct_servers: [garry-crm] # must be an alias defined above

  - id: claude-qa-1
    guilds: [qa-engineer]
```

**Env var interpolation:** Values matching `${VAR_NAME}` are resolved from the process environment at load time. Unresolved references log a `WARN` and the field is set to an empty string.

> **Important — env var rotation:** Because values are resolved from `process.env` at parse time, rotating a credential (e.g. issuing a new `GITHUB_TOKEN`) requires restarting the process. Hot reload re-parses the YAML file but cannot pick up changes to environment variables that were set before the process started. Operators must restart `mcp-aggregator` after rotating secrets, or use a secrets manager that injects env vars at startup.

**Secret handling requirements:**

- The `db.sqlite` file MUST be created with mode `0600` (owner read/write only). The proxy MUST abort startup if it cannot set these permissions.
- Resolved values of `env` and `headers` fields MUST NEVER appear in log output at any level. Log entries for upstream connections MUST reference only the key name (e.g. `"env var GITHUB_TOKEN is set"`, never the token value).
- Operators MUST NOT commit literal credential values in `mcp.yaml` to version control. The README MUST include a `.gitignore` entry for `mcp.yaml` and a warning against literal secrets.
- The `mcp.yaml` file SHOULD be created with mode `0600` on first write.
- stdio subprocess spawning MUST use `child_process.spawn` with an explicit args array (never `child_process.exec` and never shell interpolation). Resolved env var values are passed as environment variables to the subprocess, not interpolated into argument strings.

**File watching:** The proxy watches `mcp.yaml` for changes using [chokidar](https://github.com/paulmillr/chokidar). On modification, it re-parses the file, diffs against the current in-memory config, and triggers a hot reload for affected sessions (§8). No restart required. `chokidar` is preferred over `fs.watch` for cross-platform reliability — `fs.watch` is unreliable on NFS mounts, Docker volume mounts, and some Linux kernel configurations.

**Config file security requirements:**

- The proxy MUST resolve `mcp.yaml` to its real path (`fs.realpath`) on startup and refuse to load if the resolved path differs from the configured path (symlink protection). The same check MUST be applied on each hot-reload event.
- On parse error during hot reload, the proxy MUST retain the last valid configuration and log an `ERROR` with the parse error. It MUST NOT partially apply a broken config.
- stdio subprocess spawning MUST use `child_process.spawn` with an explicit args array, never `child_process.exec`. This MUST be enforced in code review to prevent regression.

### Runtime settings

| Key in YAML             | CLI flag       | Env var                                  | Default                   | Description                                                                                                 |
| ----------------------- | -------------- | ---------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `port`                  | `--port`       | `MCP_AGGREGATOR_PORT`                    | `4000`                    | Primary HTTP listen port                                                                                    |
| `apiPort`               | `--api-port`   | `MCP_AGGREGATOR_API_PORT`                | unset                     | Optional second port for UI+API only (two-port layout)                                                      |
| `publicUrl`             | `--public-url` | `MCP_AGGREGATOR_PUBLIC_URL`              | `http://localhost:{port}` | Advertised base URL in agent instructions and UI links                                                      |
| `home`                  | `--home`       | `MCP_AGGREGATOR_HOME`                    | `~/.mcp-aggregator`       | Root directory for `mcp.yaml` and `db.sqlite`                                                               |
| `migrationPrompt`       | —              | `MCP_AGGREGATOR_MIGRATION_PROMPT`        | `interactive`             | `never`/`always`/`interactive` — controls migration auto-apply at startup. Set to `never` in CI and Docker. |
| `toolWarnThreshold`     | —              | `MCP_AGGREGATOR_TOOL_WARN_THRESHOLD`     | `128`                     | Tool count above which a warning is logged and included in `mcp__describe` response                         |
| `upstreamConcurrency`   | —              | `MCP_AGGREGATOR_UPSTREAM_CONCURRENCY`    | `10`                      | Max parallel upstream connections per session-start                                                         |
| `reloadDebounceMs`      | —              | `MCP_AGGREGATOR_RELOAD_DEBOUNCE_MS`      | `300`                     | Debounce window (ms) for chokidar file change events                                                        |
| `httpKeepaliveMs`       | —              | `MCP_AGGREGATOR_HTTP_KEEPALIVE_MS`       | `30000`                   | Ping interval for idle streamablehttp upstreams                                                             |
| `disableGuildHints`     | —              | `MCP_AGGREGATOR_DISABLE_GUILD_HINTS`     | `false`                   | When true, `clientInfo.name` is never interpreted as a guild hint                                           |
| `disableGuildEndpoints` | —              | `MCP_AGGREGATOR_DISABLE_GUILD_ENDPOINTS` | `false`                   | When true, `/mcp/guilds/:slugs` untracked endpoints return 403                                              |
| `allowPrivateUrls`      | —              | `MCP_AGGREGATOR_ALLOW_PRIVATE_URLS`      | `false`                   | When false, private IP ranges are rejected in upstream HTTP URLs                                            |

**Migration auto-apply:** On startup, the server checks for pending Drizzle migrations. If `MCP_AGGREGATOR_MIGRATION_PROMPT=never` (default in Docker and CI), pending migrations are applied automatically without prompt. If migrations fail, the server exits with a non-zero code — it does not start against a stale schema. `drizzle.config.ts` must point to the compiled JavaScript schema output (`dist/db/schema.js`) so that `drizzle-kit generate` does not require `tsx` at runtime. The build step (`pnpm build:server`) must complete before `pnpm db:generate` or `pnpm db:migrate` are run.

### SQLite — runtime and audit state

SQLite at `$MCP_AGGREGATOR_HOME/db.sqlite` stores what the YAML cannot: dynamic runtime state.

| What lives in SQLite                                                      | What lives in YAML      |
| ------------------------------------------------------------------------- | ----------------------- |
| Session records (connected/disconnected, tools served, upstream statuses) | Server definitions      |
| Agent `last_seen_at`, `session_count`, `client_info`                      | Guild definitions       |
| Auto-registered agents (not in YAML)                                      | Agent guild assignments |
| Runtime overrides written via REST API                                    | Env vars and headers    |
| Cached tool names per upstream server                                     | —                       |

**Config authority:** YAML takes precedence for anything defined in it. If an agent appears in both YAML and SQLite (auto-registered), the YAML guild assignments win on reload. If an agent is only in SQLite (auto-registered, not in YAML), its guild assignments are editable via REST API and persisted in SQLite.

---

## 3.2 Development Standards & Conventions

### Project scaffold

The initial repo layout follows the patterns established by [mcpdotdirect/template-mcp-server](https://github.com/mcpdotdirect/template-mcp-server), adapted for `@modelcontextprotocol/sdk` (the official SDK) instead of FastMCP, and extended for the aggregator's multi-component architecture.

```
mcp-proxy/
├── .changeset/
│   └── config.json               # Changesets configuration
├── .github/
│   └── workflows/
│       ├── ci.yml                 # PR checks: typecheck, lint, test, build
│       └── release.yml            # Release: build, Docker push, GitHub release
├── bin/
│   ├── mcp-aggregator.ts          # CLI entry point (compiled → dist/bin/)
│   └── mcp-aggregator-stdio.ts    # stdio wrapper for Claude Desktop
├── src/
│   ├── server/
│   │   ├── http.ts                # Express app setup, route mounting
│   │   ├── mcp.ts                 # MCP Streamable HTTP handler
│   │   └── api.ts                 # REST API router
│   ├── aggregator/
│   │   ├── engine.ts              # Session lifecycle, capability merging
│   │   ├── router.ts              # Agent/guild URL routing
│   │   └── namespace.ts           # Tool/resource/prompt namespacing
│   ├── upstream/
│   │   ├── manager.ts             # Connection pool per session
│   │   ├── stdio.ts               # stdio transport (child_process.spawn)
│   │   ├── http.ts                # StreamableHTTP transport
│   │   └── sse.ts                 # SSE (legacy) transport
│   ├── db/
│   │   ├── schema.ts              # Drizzle schema (all tables)
│   │   ├── client.ts              # better-sqlite3 + Drizzle client
│   │   └── migrations/            # Generated migration files
│   ├── config/
│   │   ├── yaml.ts                # YAML parser, env var interpolation, chokidar watcher
│   │   └── types.ts               # Config type definitions
│   ├── api/
│   │   ├── agents.ts              # /api/agents routes
│   │   ├── guilds.ts              # /api/guilds routes
│   │   ├── servers.ts             # /api/servers routes
│   │   └── sessions.ts            # /api/sessions routes
│   ├── events/
│   │   └── bus.ts                 # In-process event bus (EventEmitter)
│   └── meta-tools/
│       └── index.ts               # mcp__describe, mcp__tools_by_server, mcp__status
├── ui/                            # React frontend (Vite)
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   └── api/
│   ├── index.html
│   └── vite.config.ts
├── tests/
│   ├── unit/                      # Vitest unit tests
│   └── integration/               # Vitest integration tests (real SQLite, mock upstreams)
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── .eslintrc.json
├── .prettierrc
├── commitlint.config.js
├── vitest.config.ts
├── tsconfig.json
├── tsconfig.build.json            # Excludes tests from production build
├── package.json
├── CHANGELOG.md
└── README.md
```

### Tooling

| Tool         | Purpose                                      | Config file                 |
| ------------ | -------------------------------------------- | --------------------------- |
| TypeScript 5 | Language, strict mode                        | `tsconfig.json`             |
| esbuild      | Server bundle                                | `package.json` build script |
| Vite 6       | UI bundle                                    | `ui/vite.config.ts`         |
| ESLint       | Linting                                      | `.eslintrc.json`            |
| Prettier     | Formatting                                   | `.prettierrc`               |
| Vitest       | Tests                                        | `vitest.config.ts`          |
| commitlint   | Commit message enforcement                   | `commitlint.config.js`      |
| husky        | Git hooks (pre-commit lint, commit-msg lint) | `.husky/`                   |
| Changesets   | Version management & changelog               | `.changeset/config.json`    |

### Conventional Commits

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint:

```
<type>(<scope>): <description>

Types: feat | fix | docs | chore | test | refactor | perf | ci | build
Scopes: aggregator | upstream | api | ui | db | config | meta-tools | cli | docker

Examples:
  feat(aggregator): add multi-guild deduplication
  fix(upstream): handle stdio spawn failure gracefully
  docs(api): clarify YAML precedence for REST API writes
  chore(deps): bump @modelcontextprotocol/sdk to 1.x
```

`BREAKING CHANGE:` in the commit footer triggers a major version bump.

### Versioning & Changelog

Versioning is managed by [Changesets](https://github.com/changesets/changesets):

- Every PR that changes behaviour includes a changeset file (`pnpm changeset`)
- Changesets are consumed on merge to `main` to bump `package.json` and generate `CHANGELOG.md`
- Patch / minor / major maps to semver in the standard way
- `CHANGELOG.md` is auto-generated — do not hand-edit it

### `package.json` scripts

```json
{
  "bin": {
    "mcp-aggregator": "dist/bin/mcp-aggregator.js",
    "mcp-aggregator-stdio": "dist/bin/mcp-aggregator-stdio.js"
  },
  "scripts": {
    "dev": "tsx watch bin/mcp-aggregator.ts -- start",
    "build": "pnpm build:server && pnpm build:cli && pnpm build:stdio && pnpm build:ui",
    "build:server": "esbuild src/server/http.ts --bundle --platform=node --outfile=dist/server.js",
    "build:cli": "esbuild bin/mcp-aggregator.ts --bundle --platform=node --outfile=dist/bin/mcp-aggregator.js",
    "build:stdio": "esbuild bin/mcp-aggregator-stdio.ts --bundle --platform=node --outfile=dist/bin/mcp-aggregator-stdio.js",
    "build:ui": "vite build ui/",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ ui/src/ --ext .ts,.tsx",
    "test": "vitest",
    "test:run": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "changeset": "changeset",
    "version": "changeset version",
    "release": "pnpm build && changeset publish"
  }
}
```

> **Note on `dev` script:** `bin/mcp-aggregator.ts` is the full entry point for the CLI (config loading, YAML watching, port binding). Running `src/server/http.ts` directly would bypass config initialization. The `dev` script goes through the CLI entry point for parity with the production binary.

### Testing strategy

Tests are divided into three tiers that map to the component layers:

| Tier        | Location             | Uses real                                                               | Purpose                                                                                                                                 |
| ----------- | -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `tests/unit/`        | Nothing external                                                        | Namespacing logic, alias validation, state machine transitions, event bus ordering, YAML config parsing, session resolver deduplication |
| Integration | `tests/integration/` | Real SQLite (in-memory via `:memory:`), `MockUpstreamManager`           | Full session lifecycle, hot reload, REST API, guild resolution, DB queries                                                              |
| End-to-end  | `tests/e2e/`         | Real SQLite, real `node` subprocesses running a minimal MCP echo server | stdio transport, full MCP initialize + tools/list flow, stdio wrapper                                                                   |

**Unit test doubles:** Vitest mocks are not used for component interfaces — instead, lightweight hand-written test doubles are checked in at `tests/doubles/`:

```
tests/doubles/
├── InMemoryConfigStore.ts    // IConfigStore backed by plain Maps
├── MockUpstreamManager.ts    // IUpstreamManager with controllable handles
├── TestEventBus.ts           // IEventBus that records all published events
└── StaticConfigLoader.ts     // IConfigLoader that returns a fixed ResolvedConfig
```

These doubles are used directly in unit and integration tests. The `InMemoryConfigStore` is the most widely used — it allows testing all aggregator engine logic without an open file descriptor. `TestEventBus` makes event ordering assertions trivial.

**Integration test database:** Integration tests use SQLite `":memory:"` passed as `DATABASE_URL`. Migrations are applied using `drizzle-kit push` (not `drizzle-kit migrate`) against the in-memory connection at test setup. Each test suite gets a fresh database. No test ever touches `~/.mcp-aggregator/db.sqlite`.

---

## 3.3 Deployment Security Requirements

**v1 deployments MUST be network-isolated.** The MCP port (default 4000) MUST NOT be exposed to untrusted networks.

**Default bind address:** The default bind address for v1 is `127.0.0.1`, not `0.0.0.0`. Using `0.0.0.0` requires an explicit `--bind 0.0.0.0` flag. The README and Docker Compose MUST include a warning: `# WARNING: no agent authentication in v1 — bind to loopback or trusted network only`.

**Multi-tenant / internet-facing deployments:** In deployments where tool access must be strictly controlled, Milestone 7 agent API key authentication is a hard prerequisite before exposing `/mcp/agents/:id` endpoints to untrusted networks.

**REST API security:** In v1 (single-operator, local/trusted-network mode), REST API endpoints are unauthenticated. The API port MUST NOT be exposed to untrusted networks. Milestone 7 introduces `MCP_AGGREGATOR_API_KEY` bearer token authentication for all write endpoints. Until then, use network-layer controls (firewall rules, bind address restriction) to limit API access.

---

## 4. Non-Goals (v1)

- Not a load balancer
- Not a secrets manager (env var values stored plaintext in SQLite; encryption in v2). Values are **never returned** by any API or UI endpoint — only keys are exposed.
- Not multi-tenant (single operator)
- No sampling proxy (server-initiated LLM calls not forwarded)
- No resource subscriptions proxy
- No OAuth flow for upstream auth (static bearer tokens only)

---

## 5. Components

### 5.1 Agent Router

Maps incoming MCP connections to the correct MCP capability set.

**URL patterns:**

| URL                                | Description                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp/agents/:agent-id`            | Per-agent endpoint. The agent ID is a user-supplied slug from the URL path (e.g. `garry`). No authentication — the proxy trusts the ID as-is and treats the caller as that agent. Auto-registers on first connect. Serves union of all the agent's guild MCPs + direct assignments.                                                                   |
| `/mcp/guilds/:guild-slug`          | Untracked single-guild endpoint. Any client here gets that guild's MCPs. No agent record is created.                                                                                                                                                                                                                                                  |
| `/mcp/guilds/:slug1,:slug2,:slug3` | Untracked **multi-guild** endpoint. Comma-separated slugs. Serves the union of all listed guilds. Any number of guilds. No agent record created. Note: commas are valid unencoded in URL paths (RFC 3986 §3.3); percent-encoded `%2C` is also accepted. Operators behind reverse proxies that encode commas must configure pass-through or use `%2C`. |
| `/mcp`                             | Default endpoint. Serves a special `default` guild (seeded empty at startup).                                                                                                                                                                                                                                                                         |

**Examples:**

```
# Single guild (untracked)
http://localhost:4000/mcp/guilds/qa-engineer

# Multiple guilds (untracked) — comma-separated, any order
http://localhost:4000/mcp/guilds/qa-engineer,developer,ceo

# Named agent (tracked, unauthenticated — trusts the slug in the URL)
http://localhost:4000/mcp/agents/garry
```

**Agent auto-registration:** When a client hits `/mcp/agents/garry` for the first time, the proxy auto-creates an agent record using `garry` as the ID. The ID is taken directly from the URL path — there is no authentication; the proxy trusts the caller is who it says it is. Agent IDs must be treated as user-supplied strings: they are HTML-escaped before display in the web UI to prevent XSS, and stored as-is in SQLite. Agent starts with no guilds (empty tool list + hint message). Assign guilds via the YAML config or the REST API.

**Agent ID validation:** Agent IDs MUST match the pattern `^[a-z0-9][a-z0-9-]{0,62}$` (1–63 characters, lowercase alphanumeric and hyphens, must start with alphanumeric). IDs not matching this pattern are rejected with HTTP 400 / JSON-RPC error before any database lookup. IDs containing path separators, null bytes, control characters, or percent-encoded characters that decode to any of the above are rejected. This validation applies to both the MCP connect path and the `POST /agents` REST API endpoint.

**Self-declared guild hint (optional):** An agent may request specific guilds on first connect by passing a comma-separated list of guild slugs as `clientInfo.name` (e.g. `"qa-engineer,developer"`). The proxy uses this hint **only** when all of the following are true:

1. The agent is newly registering (no existing record in `agents`)
2. The value is an exact match for the regex `^[a-z][a-z0-9-]*(?:,[a-z][a-z0-9-]*)*$` — i.e. it looks like a pure list of slugs, not a real application name like `"Claude Code 1.2.3"`
3. Every slug in the list resolves to an existing guild

If any slug does not resolve, the entire hint is discarded and the agent starts with no guilds. When this happens the proxy logs a warning at `WARN` level: `"Guild hint discarded for agent '{id}': unknown slugs ['{slug}', ...]"` so operators can diagnose misconfigured hints. The initialize response `instructions` field also signals the discard: `"Guild hint was discarded (unknown slugs: ['{slug}']). This agent ({id}) has no guild assigned. Assign a guild in the MCP Aggregator UI at {MCP_AGGREGATOR_PUBLIC_URL}/agents/{id}."` This surfaces the problem to any client that displays instructions, not just server logs. The hint is a convenience only — the UI can always override, and clients whose `clientInfo.name` is a real application name will never accidentally trigger it.

**Security note — guild hints:** Guild hints are a convenience for operator-controlled environments where all connecting agents are trusted. They provide no security boundary. An attacker who can reach the MCP endpoint and knows valid guild slugs can claim any guild assignment on first connect using an arbitrary agent ID. Deployments where tool access must be strictly controlled MUST either: (a) pre-register all agents in `mcp.yaml` (pre-registered agents are not subject to hints — hints apply only to auto-registration), or (b) disable guild hints entirely via `MCP_AGGREGATOR_DISABLE_GUILD_HINTS=true`. When this flag is set, `clientInfo.name` is never interpreted as a guild hint and all new agents start with no guilds regardless of `clientInfo.name` content.

The untracked `/mcp/guilds/:slugs` endpoint is similarly unrestricted; set `MCP_AGGREGATOR_DISABLE_GUILD_ENDPOINTS=true` to disable it in security-sensitive deployments, forcing all access through the per-agent endpoint where guild assignments are operator-controlled.

### 5.1.1 Component Interface Contracts

Each major component exposes a strict TypeScript interface. Implementations depend only on the interface, never the concrete class. This is the primary seam for unit testing — any component can be replaced with a test double by satisfying its interface.

```typescript
// src/config/types.ts — already exists; the resolved, validated config shape
export interface ResolvedConfig {
  port: number;
  apiPort?: number;
  publicUrl: string;
  home: string;
  servers: ResolvedServerConfig[];
  guilds: GuildConfig[];
  agents: AgentConfig[];
  // ... runtime settings
}

// src/config/IConfigLoader
export interface IConfigLoader {
  /** Load and parse mcp.yaml synchronously; throws on parse error or symlink violation */
  load(): ResolvedConfig;
  /** Begin watching for file changes; calls onReload on each debounced valid change */
  watch(onReload: (next: ResolvedConfig, prev: ResolvedConfig) => void): () => void;
}

// src/db/IConfigStore
export interface IConfigStore {
  getAgent(id: string): AgentRow | undefined;
  upsertAgent(agent: AgentRow): void;
  getAgentGuilds(agentId: string): GuildRow[];
  getAgentDirectServers(agentId: string): ServerRow[];
  getServer(id: string): ServerRow | undefined;
  listServers(): ServerRow[];
  // ... full CRUD surface — see §5.4 for tables
  /** Sync YAML-declared entities to DB; sets yaml_managed = 1 */
  syncFromYaml(config: ResolvedConfig): void;
  /** Write disconnected_at for all open sessions (crash recovery) */
  recoverStaleSessions(): number;
}

// src/aggregator/IAggregatorEngine
export interface IAggregatorEngine {
  /**
   * Resolve and connect upstreams for an inbound MCP session.
   * Returns a SessionContext used for the life of the session.
   */
  createSession(params: CreateSessionParams): Promise<SessionContext>;
  /** Tear down a session: drain in-flight calls, kill upstreams, write disconnected_at */
  closeSession(sessionId: string, reason: CloseReason): Promise<void>;
  /** Reload upstreams for sessions affected by a config change */
  reloadSessions(affectedAgentIds: Set<string>): Promise<void>;
  /** Current in-memory session registry (read-only) */
  readonly sessions: ReadonlyMap<string, SessionContext>;
}

// src/upstream/IUpstreamManager
export interface IUpstreamManager {
  connect(server: ResolvedServerConfig, sessionId: string): Promise<UpstreamHandle>;
  disconnect(handle: UpstreamHandle): Promise<void>;
  /** Track in-flight call; returns a decrement function */
  trackCall(handle: UpstreamHandle): () => void;
}

// src/upstream/IUpstreamHandle  (returned by IUpstreamManager.connect)
export interface UpstreamHandle {
  readonly serverId: string;
  readonly alias: string;
  readonly status: UpstreamStatus; // "connected" | "error" | "disconnected"
  callTool(name: string, args: unknown): Promise<ToolCallResult>;
  listTools(): Promise<ToolDef[]>;
  listResources(): Promise<ResourceDef[]>;
  listPrompts(): Promise<PromptDef[]>;
  readResource(uri: string): Promise<ResourceContent>;
  getPrompt(name: string, args: unknown): Promise<PromptResult>;
  ping(): Promise<void>;
}

// src/events/IEventBus
export interface IEventBus {
  publish<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
  subscribe<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void
  ): () => void;
}
```

**Dependency injection pattern:** The three primary production singletons (`ConfigLoader`, `ConfigStore`, `AggregatorEngine`) are constructed once in `bin/mcp-aggregator.ts` and passed explicitly to everything that needs them. No module-level singletons; no `import { db } from '../db/client'` in business logic. The entry point wires the graph:

```typescript
// bin/mcp-aggregator.ts (sketch)
const config = new YamlConfigLoader(home);
const store = new SqliteConfigStore(dbPath);
const bus = new TypedEventBus();
const manager = new UpstreamConnectionManager(bus);
const engine = new AggregatorEngine(store, manager, bus);
const app = buildExpressApp({ engine, store, bus, config });
```

In tests, `SqliteConfigStore` is replaced by `InMemoryConfigStore`, `UpstreamConnectionManager` by `MockUpstreamManager`, etc. — no test ever needs a real SQLite file or a real child process unless it is an integration test.

### 5.2 Aggregator Engine

Core logic that resolves which upstream MCP servers to connect to for a session, connects to them, merges their capabilities, and routes requests.

For a given session the capability set is:

```
servers = deduplicate(
  union( guild_servers(g) for g in agent.guilds )  ∪  agent_direct_servers(agent.id)
)
```

Deduplication is by `server_id` — the same upstream server appearing in multiple guilds or as a direct assignment results in exactly one upstream connection, and its tools appear once in the tool list. All sets follow the same namespacing rules (§7).

**Server set resolution algorithm (authoritative):** Called by the engine at session start and on each reload. Returns an ordered list of `ResolvedServerConfig` values to connect.

```
function resolveServerSet(agentId: string, store: IConfigStore): ResolvedServerConfig[] {
  const guilds    = store.getAgentGuilds(agentId)          // ordered by added_at ASC
  const direct    = store.getAgentDirectServers(agentId)   // ordered by added_at ASC

  const seen    = new Set<string>()   // server_id deduplication
  const result  = []

  for (const guild of guilds) {
    for (const server of store.getGuildServers(guild.id)) {  // ordered by added_at ASC
      if (!seen.has(server.id) && server.enabled) {
        seen.add(server.id)
        result.push({ ...server, _via: { type: 'guild', guildSlug: guild.slug } })
      }
    }
  }
  for (const server of direct) {
    if (!seen.has(server.id) && server.enabled) {
      seen.add(server.id)
      result.push({ ...server, _via: { type: 'direct' } })
    }
  }
  return result
}
```

Disabled servers (`enabled = 0`) are excluded from the result set — they are never connected for any session. The `_via` metadata is attached to the upstream handle so the meta-tools (`mcp__describe`, `mcp__tools_by_server`) can report source attribution without re-querying the DB.

**Session isolation:** Each MCP session gets its own upstream connection pool. Two simultaneous sessions for the same agent (e.g. two Claude Code windows both using `garry`) each maintain independent upstream connections. There is no shared connection pool across sessions of the same agent. This means:

- A hot-reload event broadcasts `notifications/tools/list_changed` to all active sessions for that agent independently
- If an upstream fails for one session it does not affect the other
- Upstream connections are not reused across sessions (connection pooling across sessions is a v2 concern)

**Aggregator Engine responsibility boundary:** The engine owns exactly three concerns:

1. **Session lifecycle** — create, reload, close (orchestrates the upstream manager and DB writes).
2. **Capability resolution** — resolve the correct server set for a session from the config store, apply deduplication, apply namespacing.
3. **Request routing** — for `tools/call`, `resources/read`, `prompts/get`, `completion/complete`: extract the alias prefix, identify the correct upstream handle, forward the de-namespaced request.

The engine does **not** own: transport logic (that is the upstream manager's job), HTTP request/response parsing (the MCP server handler's job), SQL query composition (the config store's job), or YAML parsing (the config loader's job). Any function in `aggregator/engine.ts` that directly constructs a `child_process.spawn` call or writes raw SQL is a violation of this boundary.

### 5.2.1 Session Lifecycle State Machine

Every session managed by the Aggregator Engine moves through the following states. Transitions are the only way state changes. Illegal transitions (e.g. `connecting → closed` without passing through `active`) MUST be rejected with an internal error and logged at `ERROR` level.

```
                        ┌──────────────────┐
                        │   INITIALIZING   │◄─── createSession() called
                        │  (resolving set, │
                        │   connecting     │
                        │   upstreams)     │
                        └────────┬─────────┘
                                 │ all connect attempts settled
                    ┌────────────▼───────────────┐
                    │          ACTIVE             │◄─── tools/call, tools/list, etc. served
                    │  (≥0 upstreams connected;   │
                    │   in-flight calls tracked)  │
                    └───┬──────────────────┬──────┘
                        │                 │
          reload event  │                 │  closeSession() / stream drop
                        ▼                 ▼
            ┌──────────────────┐   ┌────────────────┐
            │    RELOADING     │   │    DRAINING    │
            │  (draining old   │   │  (waiting for  │
            │   upstreams,     │   │   in-flight    │
            │   connecting new)│   │   calls to     │
            └────────┬─────────┘   │   settle)      │
                     │             └───────┬─────────┘
                     │ reload complete     │ drain complete (or timeout)
                     ▼                     ▼
                ┌──────────────────────────────────────┐
                │               ACTIVE                 │ (loop back)
                └──────────────────────────────────────┘
                     │                     │
                     │ closeSession()       │ closeSession()
                     ▼                     ▼
                ┌──────────────────────────────────────┐
                │               CLOSED                 │
                │  (all upstreams killed, DB written,  │
                │   in-memory handle discarded)        │
                └──────────────────────────────────────┘
```

**State definitions:**

| State          | Description                                                                                                                                                                                                                                | Allowed operations                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `INITIALIZING` | Upstreams being connected in parallel; session record written to DB with no `disconnected_at`.                                                                                                                                             | None from external callers — requests are queued for up to `aggregate_deadline` ms, then rejected if still initializing. |
| `ACTIVE`       | Session live; zero or more upstreams connected (some may be in `error` state).                                                                                                                                                             | `tools/list`, `tools/call`, `resources/*`, `prompts/*`, `mcp__*` meta-tools, reload.                                     |
| `RELOADING`    | A hot-reload event is being processed. Old upstream handles are being drained; new handles are being connected. New `tools/call` requests targeting draining upstreams are queued for 500 ms then rejected if the new handle is not ready. | Read-only meta-tools (`mcp__describe`, `mcp__status`) served from snapshot; tool calls queued or rejected as above.      |
| `DRAINING`     | `closeSession()` called; waiting for in-flight calls to complete before killing upstreams. New requests rejected immediately with `isError: true`.                                                                                         | Nothing new; in-flight calls complete.                                                                                   |
| `CLOSED`       | Terminal state. In-memory handle removed. DB row has `disconnected_at` set.                                                                                                                                                                | None — references to this session are stale.                                                                             |

**Concurrent reload + close:** If `closeSession()` is called while the session is in `RELOADING`, the reload is abandoned (pending connect attempts are cancelled), the session transitions directly to `DRAINING`, and proceeds to `CLOSED`. The newly initiated upstream connections that were mid-flight during the reload are killed without writing their status to the DB.

### 5.3 Upstream Connection Manager

Manages connections to individual upstream MCP servers.

**Supported transports:**

| Transport type   | SDK class                       | Notes                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stdio`          | —                               | Spawns subprocess via Node `child_process.spawn`. One process per upstream per session.                                                                                                                                                                                                                                                                      |
| `streamablehttp` | `StreamableHTTPClientTransport` | Uses `@modelcontextprotocol/sdk`. Supports stateful and stateless modes.                                                                                                                                                                                                                                                                                     |
| `sse`            | `SSEClientTransport`            | Legacy transport via `@modelcontextprotocol/sdk`. No reconnect on disconnect — if the SSE stream drops mid-session the upstream is marked disconnected and `tools/list_changed` is emitted. After the notification, `tools/list` omits that upstream's tools for the remainder of the session. Reconnect is only attempted at the start of the next session. |

**Connection lifecycle:**

- All upstreams for a session are connected eagerly at session start, in parallel
- Failed upstreams are skipped (logged, not fatal); the session continues with remaining upstreams
- `upstream_statuses` snapshot is written to `sessions` after all connection attempts resolve
- After a successful connection, discovered tool names are written to `server_tool_cache` (upsert by `server_id` + `tool_name`) — see §5.4

**Aggregate session-start deadline:** An additional top-level timeout MUST be applied over the parallel connection phase. The deadline is `min(max(individual timeout_ms values) + 5000, 60000)` ms, evaluated at session start from the set of configured upstreams. If this aggregate deadline expires before all connection attempts have settled, any still-pending connections are cancelled (stdio subprocesses killed), marked `"skipped"`, and the session proceeds with whichever upstreams completed in time. The aggregate deadline value is logged at `INFO` level.

**Connection retry policy (session start):** Before marking an upstream as `"skipped"`, the connection manager MUST attempt a single retry after a fixed 1-second delay. This handles the common case of a stdio subprocess that is slow to print its initial ready signal. Only one retry is performed at session start; subsequent failures are final for the session. The aggregate deadline still applies across the retry.

**Connection concurrency limit:** The connection manager MUST limit per-session upstream connection concurrency to a maximum of `MCP_AGGREGATOR_UPSTREAM_CONCURRENCY` (default: `10`). Connections beyond this limit are queued and initiated as earlier connections settle. This prevents a single session from exhausting OS file descriptors or spawning limits.

**Subprocess lifecycle guarantees:**

1. **Session disconnect cleanup:** When a session ends for any reason (clean MCP close, HTTP stream drop, force-close via API, or aggregate deadline expiry), the Upstream Connection Manager MUST call `subprocess.kill('SIGTERM')` on every stdio child process associated with that session, followed by a 3-second grace period, after which `subprocess.kill('SIGKILL')` is sent if the process has not exited. Cleanup MUST be performed even if the HTTP response stream was already closed.
2. **Graceful shutdown (SIGTERM to proxy):** On receiving SIGTERM, the proxy MUST complete the above cleanup for all active sessions before exiting. A 10-second total shutdown deadline applies; processes not exited within it are SIGKILL'd. The process MUST exit with code 0 after cleanup.
3. **Process registration:** All spawned subprocesses MUST be tracked in a process registry keyed by session ID so the cleanup path can enumerate them without relying on in-memory connection handles that may already be freed.

**HTTP upstream keep-alive probing:** For `streamablehttp` upstreams, the connection manager MUST issue a lightweight MCP `ping` request at an interval of `MCP_AGGREGATOR_HTTP_KEEPALIVE_MS` (default: `30000` ms, min: `5000` ms) when the upstream has been idle (no `tools/call` traffic) for that interval. A failed ping transitions the upstream to `"error"` state, emits `notifications/tools/list_changed`, and logs a `WARN`. A subsequent successful ping transitions back to `"connected"` and re-emits `notifications/tools/list_changed`. This ping-based health check does not apply to `stdio` upstreams (liveness is inferred from the subprocess's running state) or `sse` upstreams (handled via stream closure events).

**Input validation for upstream server config:**

- `url` (HTTP transports): MUST be validated as a well-formed absolute HTTP/HTTPS URL. Private IP ranges (RFC 1918), link-local (`169.254.0.0/16`), loopback (`127.0.0.0/8`), and IPv6 equivalents are permitted only when `MCP_AGGREGATOR_ALLOW_PRIVATE_URLS=true` is explicitly set (default: `false`).
- `command` (stdio transports): stdio transport inherits the full process environment and runs as the same user as the proxy. Operators must treat `command` as equivalent to shell execution and restrict API access accordingly.
- `alias`: Validated at write time against `[a-z][a-z0-9-]*` (letters, digits, hyphens; no underscores). Reject aliases matching reserved patterns.

> **Operational warning — stdio subprocess count:** Each active MCP session spawns one subprocess per stdio upstream. With S concurrent sessions and U stdio upstreams, the process table grows by S × U. For example: 20 agents × 3 sessions each × 5 stdio upstreams = 300 child processes. Plan host capacity accordingly. Cross-session subprocess sharing is a v2 concern (Open Question #9).

**`/servers/:id/test` timeout:** The test connection endpoint (§9) uses the server's configured `timeout_ms` (default 30 000 ms) as the connection timeout. If the upstream does not respond within that window, the endpoint returns a timeout error. For stdio transports, the spawned subprocess is killed after the timeout.

### 5.4 Config Store (SQLite)

Database at `~/.mcp-aggregator/db.sqlite` (configurable via `MCP_AGGREGATOR_HOME`).

**`default` guild:** A guild with `slug = 'default'` is seeded at startup if it does not exist (`INSERT OR IGNORE`). It starts empty. The `/mcp` endpoint always resolves to this guild. Operators can add servers to it via the UI like any other guild; its slug and id are reserved and cannot be deleted.

**Required SQLite pragmas:** The database client (`src/db/client.ts`) MUST set the following pragmas on every new connection before any other operation:

```sql
PRAGMA journal_mode = WAL;        -- enables concurrent reads alongside writes
PRAGMA synchronous   = NORMAL;    -- safe with WAL; faster than FULL
PRAGMA busy_timeout  = 5000;      -- retry for 5 s before returning SQLITE_BUSY
PRAGMA cache_size    = -8000;     -- 8 MB page cache (negative = kibibytes)
PRAGMA foreign_keys  = ON;        -- enforce FK constraints (not persistent across connections)
PRAGMA temp_store    = MEMORY;    -- keep temp tables/indices in RAM, not disk
PRAGMA mmap_size     = 134217728; -- 128 MB memory-mapped I/O (reduces pread syscall overhead)
```

**Pragma ordering is mandatory**: `journal_mode = WAL` must be set first. `synchronous = NORMAL` has different semantics depending on whether WAL is active — setting it before `journal_mode` may apply rollback-journal sync semantics. `foreign_keys = ON` must be set after `journal_mode` because foreign key checks interact with WAL-mode read snapshots. See §5.4.3 for the authoritative initialization sequence.

WAL mode is the single most important setting: it allows readers to proceed concurrently with a writer, eliminating read-write starvation that occurs under the default rollback-journal mode when hot-reload writes contend with session-start reads.

**WAL checkpoint behaviour:** The WAL file grows until checkpointed. SQLite performs automatic passive checkpoints at the 1000-page threshold (`PRAGMA wal_autocheckpoint`). This is usually sufficient but can cause occasional latency spikes during a checkpoint. The application MUST also trigger a manual `PRAGMA wal_checkpoint(TRUNCATE)` during graceful shutdown (§16.5 step 6) and a periodic `PRAGMA wal_checkpoint(PASSIVE)` every 5 minutes during idle periods. See §5.4.3 for the checkpoint implementation.

#### `upstream_servers`

| Column               | Type                 | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | TEXT UUID            | PK                                                                                                                                                                                                                                                                                                                                                                                             |
| `name`               | TEXT                 | Display name                                                                                                                                                                                                                                                                                                                                                                                   |
| `alias`              | TEXT UNIQUE          | Slug for tool namespacing, e.g. `github`. Pattern: `[a-z][a-z0-9-]*` (letters, digits, hyphens — no underscores). Underscores are excluded so that the `{alias}__` separator is unambiguous and so that `mcp+{alias}://` is a valid URI scheme per RFC 3986. **Globally unique** — no two servers may share an alias regardless of guild membership. Rejected at write time with 409 if taken. |
| `transport_type`     | TEXT                 | `stdio` \| `streamablehttp` \| `sse`                                                                                                                                                                                                                                                                                                                                                           |
| `command`            | TEXT                 | stdio: executable                                                                                                                                                                                                                                                                                                                                                                              |
| `args`               | TEXT (JSON array)    | stdio: arguments                                                                                                                                                                                                                                                                                                                                                                               |
| `url`                | TEXT                 | HTTP: endpoint URL                                                                                                                                                                                                                                                                                                                                                                             |
| `enabled`            | INTEGER              | Global kill-switch (0/1). Disabled = never connected for any agent/guild.                                                                                                                                                                                                                                                                                                                      |
| `timeout_ms`         | INTEGER              | Default 30000                                                                                                                                                                                                                                                                                                                                                                                  |
| `created_at`         | TEXT ISO8601         |                                                                                                                                                                                                                                                                                                                                                                                                |
| `updated_at`         | TEXT ISO8601         |                                                                                                                                                                                                                                                                                                                                                                                                |
| `last_connected_at`  | TEXT ISO8601 \| NULL | Timestamp of last successful connection (any session). Updated on each successful connect.                                                                                                                                                                                                                                                                                                     |
| `last_error_at`      | TEXT ISO8601 \| NULL | Timestamp of last failed connection attempt.                                                                                                                                                                                                                                                                                                                                                   |
| `last_error_message` | TEXT \| NULL         | Error from last failed attempt. Truncated to 1000 chars. Cleared on next successful connect.                                                                                                                                                                                                                                                                                                   |
| `consecutive_errors` | INTEGER              | NOT NULL DEFAULT 0. Reset to 0 on successful connect. Used by the UI health indicator.                                                                                                                                                                                                                                                                                                         |
| `cached_tool_count`  | INTEGER              | NOT NULL DEFAULT 0. Updated on each successful cache write.                                                                                                                                                                                                                                                                                                                                    |
| `yaml_managed`       | INTEGER              | NOT NULL DEFAULT 0. 1 = inserted/updated by YAML reload. 0 = REST API or auto.                                                                                                                                                                                                                                                                                                                 |

#### `upstream_env_vars`

| Column       | Type                  | Notes                                                                                                                                                                                                                         |
| ------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | TEXT UUID             | PK                                                                                                                                                                                                                            |
| `server_id`  | FK → upstream_servers |                                                                                                                                                                                                                               |
| `key`        | TEXT                  |                                                                                                                                                                                                                               |
| `value`      | TEXT                  | **Write-only.** Never returned by any API or UI. Only `key` is exposed externally.                                                                                                                                            |
| `created_at` | TEXT ISO8601          |                                                                                                                                                                                                                               |
| `updated_at` | TEXT ISO8601          | Set when the row is created. Since `PUT /servers/:id/env` does a full delete-and-reinsert, each row's `updated_at` equals its `created_at`. This column is included for schema consistency and future partial-update support. |

#### `upstream_headers`

| Column       | Type                  | Notes                                                                              |
| ------------ | --------------------- | ---------------------------------------------------------------------------------- |
| `id`         | TEXT UUID             | PK                                                                                 |
| `server_id`  | FK → upstream_servers |                                                                                    |
| `key`        | TEXT                  |                                                                                    |
| `value`      | TEXT                  | **Write-only.** Never returned by any API or UI. Only `key` is exposed externally. |
| `created_at` | TEXT ISO8601          |                                                                                    |
| `updated_at` | TEXT ISO8601          | Same semantics as `upstream_env_vars.updated_at` above.                            |

#### `guilds`

| Column         | Type         | Notes                                                                                                                                                      |
| -------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | TEXT UUID    | PK                                                                                                                                                         |
| `name`         | TEXT         | Display name, e.g. "QA Engineer"                                                                                                                           |
| `slug`         | TEXT UNIQUE  | URL-safe slug, e.g. `qa-engineer`. Read-only after creation.                                                                                               |
| `description`  | TEXT         | Optional description of what this guild is for                                                                                                             |
| `color`        | TEXT         | Hex color for UI badge, e.g. `#6366f1`. Validated as `^#[0-9a-fA-F]{6}$`, rejected with 422 otherwise.                                                     |
| `created_at`   | TEXT ISO8601 |                                                                                                                                                            |
| `updated_at`   | TEXT ISO8601 |                                                                                                                                                            |
| `is_system`    | INTEGER      | NOT NULL DEFAULT 0. 1 for system-managed guilds (currently only `'default'`). Application must reject DELETE and slug/name changes for `is_system=1` rows. |
| `yaml_managed` | INTEGER      | NOT NULL DEFAULT 0. Same semantics as `upstream_servers.yaml_managed`.                                                                                     |

#### `guild_servers`

Join table: which upstream servers belong to which guild.

| Column      | Type                  | Notes |
| ----------- | --------------------- | ----- |
| `id`        | TEXT UUID             | PK    |
| `guild_id`  | FK → guilds           |       |
| `server_id` | FK → upstream_servers |       |
| `added_at`  | TEXT ISO8601          |       |

Unique constraint: `(guild_id, server_id)`

#### `agents`

| Column                | Type         | Notes                                                                                                                                                                                                                    |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                  | TEXT         | PK. User-defined slug (from URL path). e.g. `garry`, `claude-qa-1`                                                                                                                                                       |
| `display_name`        | TEXT         | Optional friendly name, e.g. "Garry (CEO agent)"                                                                                                                                                                         |
| `client_info_name`    | TEXT         | Last seen `clientInfo.name` from initialize                                                                                                                                                                              |
| `client_info_version` | TEXT         | Last seen `clientInfo.version`                                                                                                                                                                                           |
| `last_seen_at`        | TEXT ISO8601 | Updated on each session connect                                                                                                                                                                                          |
| `session_count`       | INTEGER      | Lifetime session counter. Incremented atomically in the same transaction as the `sessions` INSERT on each new connection.                                                                                                |
| `created_at`          | TEXT ISO8601 |                                                                                                                                                                                                                          |
| `updated_at`          | TEXT ISO8601 |                                                                                                                                                                                                                          |
| `registration_source` | TEXT         | NOT NULL DEFAULT `'auto'`. Values: `'auto'` (first-connect auto-registration), `'yaml'` (pre-configured in mcp.yaml), `'api'` (created via POST /agents). Set to `'yaml'` on YAML reload for agents defined in the file. |
| `yaml_managed`        | INTEGER      | NOT NULL DEFAULT 0. Same semantics as `upstream_servers.yaml_managed`.                                                                                                                                                   |

No `guild_id` column — guild membership is in `agent_guilds` (many-to-many).

**`yaml_managed` behaviour:** On YAML reload, upsert sets `yaml_managed = 1` for all rows originating from the YAML file. REST API writes set `yaml_managed = 0`. `DELETE /agents/:id` on a `yaml_managed = 1` row must return 409 with body: `{ "error": "Agent is managed by mcp.yaml. Remove it from the file to delete.", "code": "yaml_managed" }`. `GET /agents` response includes `"yaml_managed": true/false` so the UI can show the appropriate badge.

#### `agent_guilds`

Join table: which guilds an agent belongs to.

| Column              | Type                 | Notes                                                                                                                                                                            |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | TEXT UUID            | PK                                                                                                                                                                               |
| `agent_id`          | FK → agents          |                                                                                                                                                                                  |
| `guild_id`          | FK → guilds          |                                                                                                                                                                                  |
| `added_at`          | TEXT ISO8601         |                                                                                                                                                                                  |
| `added_by`          | TEXT                 | NOT NULL DEFAULT `'api'`. Values: `'yaml'` (inserted by YAML reload), `'api'` (inserted by REST API call), `'hint'` (inserted by self-declared guild hint at auto-registration). |
| `original_added_at` | TEXT ISO8601 \| NULL | Set on INSERT, never updated. YAML reload uses INSERT OR IGNORE (not DELETE+INSERT) to preserve this. Used as tiebreaker for source attribution in `GET /agents/:id/tools`.      |

Unique constraint: `(agent_id, guild_id)`

An agent with no rows here has no guild memberships → receives 0 tools + hint message.

#### `agent_direct_servers`

Direct MCP server assignments per agent (outside of any guild).

| Column      | Type                  | Notes |
| ----------- | --------------------- | ----- |
| `id`        | TEXT UUID             | PK    |
| `agent_id`  | FK → agents           |       |
| `server_id` | FK → upstream_servers |       |
| `added_at`  | TEXT ISO8601          |       |

Unique constraint: `(agent_id, server_id)`

#### `sessions`

Active and historical MCP sessions. Capped at 1000 rows: on each `INSERT`, a cleanup query runs in the same transaction. The cap DELETE prefers evicting disconnected sessions before active ones:

```sql
DELETE FROM sessions WHERE id IN (
  SELECT id FROM sessions
  ORDER BY
    CASE WHEN disconnected_at IS NULL THEN 1 ELSE 0 END ASC,
    connected_at ASC
  LIMIT -1 OFFSET 999
)
```

This guarantees active sessions are never silently evicted from the table due to volume alone. If the proxy accumulates 1000 simultaneous active sessions, no eviction occurs and the table grows beyond 1000 rows until sessions disconnect — an over-cap active session is preferable to a lost session handle.

| Column              | Type                      | Notes                                                                                                                        |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                | TEXT UUID                 | PK                                                                                                                           |
| `agent_id`          | FK → agents \| NULL       | NULL for untracked guild URL connections                                                                                     |
| `guild_slugs`       | TEXT (JSON array) \| NULL | Guild slugs at session start (untracked multi-guild connections)                                                             |
| `connected_at`      | TEXT ISO8601              |                                                                                                                              |
| `disconnected_at`   | TEXT ISO8601 \| NULL      | NULL = still active                                                                                                          |
| `client_info`       | TEXT (JSON)               | Full clientInfo from initialize                                                                                              |
| `upstream_statuses` | TEXT (JSON)               | Snapshot: `{ alias: "connected" \| "error" \| "skipped" }`                                                                   |
| `tool_count`        | INTEGER                   | How many tools were served                                                                                                   |
| `port`              | INTEGER \| NULL           | Port on which this session was established. Useful in two-port deployments to distinguish MCP sessions from API/UI sessions. |

#### `server_tool_cache`

Stores tool names discovered from live upstream connections. Used to power the static tool list endpoints (`GET /agents/:id/tools`, `GET /guilds/:id/tools`) without requiring a live connection. Populated/updated every time an upstream connects successfully.

| Column             | Type                  | Notes                                                                 |
| ------------------ | --------------------- | --------------------------------------------------------------------- |
| `id`               | TEXT UUID             | PK                                                                    |
| `server_id`        | FK → upstream_servers |                                                                       |
| `tool_name`        | TEXT                  | Original tool name as reported by upstream (without namespace prefix) |
| `tool_description` | TEXT \| NULL          | Tool description from upstream                                        |
| `input_schema`     | TEXT (JSON) \| NULL   | JSON Schema for the tool's input parameters                           |
| `cached_at`        | TEXT ISO8601          | Timestamp of last successful discovery                                |

Unique constraint: `(server_id, tool_name)`.

**Cache eviction on successful connect:** When an upstream connects successfully and returns its tool list, the update MUST be atomic — a full replace, not an upsert:

```sql
BEGIN;
DELETE FROM server_tool_cache WHERE server_id = ?;
INSERT INTO server_tool_cache (id, server_id, tool_name, tool_description, input_schema, cached_at) VALUES …;
COMMIT;
```

This ensures removed tools are not served by static tool list endpoints. If the upstream returns zero tools (valid for servers that expose only resources), the DELETE still runs, leaving the cache empty for that server (correctly reported as a server with no tools, not in `uncached_servers`).

**Staleness indicator:** Cache rows older than 24 hours (configurable via `MCP_AGGREGATOR_CACHE_STALENESS_HOURS`, default `24`) are considered stale. The `GET /agents/:id/tools` and `GET /guilds/:id/tools` responses MUST include stale servers in a `stale_servers` array alongside `uncached_servers`.

**Disabled server exclusion:** Static tool list endpoints (`GET /agents/:id/tools`, `GET /guilds/:id/tools`) MUST exclude tools from disabled servers (`enabled = 0`). The response includes a `"disabled_servers"` array listing the aliases of servers that are part of the configuration but currently disabled.

**Static view behaviour:** If an upstream has never successfully connected, its `server_tool_cache` rows are absent. Static tool list endpoints return what is cached; a `note` field in the response indicates which servers have no cached data. Example: `"uncached_servers": ["new-server"]`.

#### `session_upstreams`

Per-session upstream connection status. Normalised companion to `sessions.upstream_statuses`. Written in the same transaction as the `sessions` INSERT.

| Column             | Type                  | Notes                                                                                                                   |
| ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`               | TEXT UUID             | PK                                                                                                                      |
| `session_id`       | FK → sessions         | ON DELETE CASCADE                                                                                                       |
| `server_id`        | FK → upstream_servers | ON DELETE CASCADE                                                                                                       |
| `status`           | TEXT                  | `connected` \| `error` \| `skipped`                                                                                     |
| `error_msg`        | TEXT \| NULL          | Error message if status = `error`                                                                                       |
| `connected_at`     | TEXT ISO8601 \| NULL  | Time upstream connection was established                                                                                |
| `disconnected_at`  | TEXT ISO8601 \| NULL  | Time upstream disconnected mid-session                                                                                  |
| `enabled_at_start` | INTEGER               | 1 if server was enabled when session started. Allows crash-recovery to know which upstreams were intentionally skipped. |

Index: `(server_id, status)` — enables querying "which sessions are connected to server X?" without JSON parsing.
Index: `(session_id)` — fast join from session to its upstreams.

`sessions.upstream_statuses` is retained for backward compatibility as a convenient denormalised snapshot for the session list display.

#### Foreign key cascade rules

`PRAGMA foreign_keys = ON` must be set on every `better-sqlite3` connection immediately after open, before any query is executed (in `src/db/client.ts`).

| Child table            | FK column    | Parent table       | ON DELETE |
| ---------------------- | ------------ | ------------------ | --------- |
| `upstream_env_vars`    | `server_id`  | `upstream_servers` | CASCADE   |
| `upstream_headers`     | `server_id`  | `upstream_servers` | CASCADE   |
| `guild_servers`        | `guild_id`   | `guilds`           | CASCADE   |
| `guild_servers`        | `server_id`  | `upstream_servers` | CASCADE   |
| `agent_guilds`         | `agent_id`   | `agents`           | CASCADE   |
| `agent_guilds`         | `guild_id`   | `guilds`           | CASCADE   |
| `agent_direct_servers` | `agent_id`   | `agents`           | CASCADE   |
| `agent_direct_servers` | `server_id`  | `upstream_servers` | CASCADE   |
| `sessions`             | `agent_id`   | `agents`           | SET NULL  |
| `server_tool_cache`    | `server_id`  | `upstream_servers` | CASCADE   |
| `session_upstreams`    | `session_id` | `sessions`         | CASCADE   |
| `session_upstreams`    | `server_id`  | `upstream_servers` | CASCADE   |

Note: `sessions.agent_id = SET NULL` preserves historical session rows when an agent is deleted — the session happened, and the agent record was later removed.

#### Required indexes

All indexes below must be included in the initial Drizzle schema (not added retroactively in a follow-up migration):

| Table                  | Index columns                 | Reason                                     |
| ---------------------- | ----------------------------- | ------------------------------------------ |
| `sessions`             | `(agent_id, disconnected_at)` | Active-session lookup per agent            |
| `sessions`             | `(connected_at DESC)`         | Session monitor list, session cap DELETE   |
| `agent_guilds`         | `(agent_id)`                  | Guild resolution at session start          |
| `agent_direct_servers` | `(agent_id)`                  | Direct-server resolution at session start  |
| `guild_servers`        | `(guild_id)`                  | Server list per guild                      |
| `guild_servers`        | `(server_id)`                 | Cascade-affected agent discovery on reload |
| `server_tool_cache`    | `(server_id)`                 | Static tool list endpoints                 |
| `upstream_env_vars`    | `(server_id)`                 | Env var lookup when connecting upstream    |
| `upstream_headers`     | `(server_id)`                 | Header lookup when connecting upstream     |
| `session_upstreams`    | `(server_id, status)`         | Server health queries                      |
| `session_upstreams`    | `(session_id)`                | Fast join from session to its upstreams    |

Note: The unique constraints on `(guild_id, server_id)`, `(agent_id, guild_id)`, and `(agent_id, server_id)` already imply unique indexes; those are covered.

---

### 5.4.1 Drizzle ORM Schema Design — Type Safety and Inference Patterns

The SQLite schema is written using `drizzle-orm/sqlite-core`. **Never use `drizzle-orm/pg-core`** — the type constructors are incompatible at runtime even though they look similar in TypeScript source. Key patterns:

**Column type inference:** Export `$inferSelect` and `$inferInsert` from every table so callers never hand-write row types:

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const upstreamServers = sqliteTable(
  'upstream_servers',
  {
    id: text('id').primaryKey(), // UUIDv4, generated at call site
    name: text('name').notNull(),
    alias: text('alias').notNull().unique(),
    transportType: text('transport_type', {
      enum: ['stdio', 'streamablehttp', 'sse'],
    }).notNull(),
    command: text('command'),
    args: text('args'), // JSON array stored as TEXT
    url: text('url'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastConnectedAt: text('last_connected_at'),
    lastErrorAt: text('last_error_at'),
    lastErrorMessage: text('last_error_message'),
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    cachedToolCount: integer('cached_tool_count').notNull().default(0),
    yamlManaged: integer('yaml_managed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => ({
    aliasIdx: uniqueIndex('upstream_servers_alias_idx').on(t.alias),
  })
);

// Exported row types — use these everywhere; never hand-write `{ id: string; alias: string; ... }`
export type UpstreamServerRow = typeof upstreamServers.$inferSelect;
export type NewUpstreamServerRow = typeof upstreamServers.$inferInsert;
```

**Enum columns:** Use Drizzle's `{ enum: [...] }` option on `text()` for transport types, status fields, and `registration_source`. This produces a TypeScript union type in `$inferSelect`, catching invalid values at compile time rather than at runtime.

**Boolean columns:** SQLite has no native boolean. Always use `integer('col', { mode: 'boolean' })` so Drizzle handles the `0`/`1` ↔ `false`/`true` mapping automatically. Never store booleans as `TEXT('0'/'1')` or raw `INTEGER` without the mode annotation — comparisons behave correctly but TypeScript sees `number` instead of `boolean`.

**JSON columns:** Store complex values (`args`, `client_info`, `upstream_statuses`) as `text('col', { mode: 'json' }).$type<YourType>()`. Drizzle will `JSON.parse`/`JSON.stringify` automatically. Attach a generic type parameter (`.${type}<ToolDefinition[]>()`) rather than leaving it as `unknown`, and validate the shape with Zod when reading from an untrusted source (e.g. upstream tool responses cached in `server_tool_cache`).

**Timestamp columns:** Store all timestamps as ISO 8601 TEXT (e.g. `new Date().toISOString()`). Do not use `integer` UNIX timestamps — they are harder to debug and `better-sqlite3` does not natively coerce them. Do not use `sqliteTable`'s `.$defaultFn(() => sql\`CURRENT_TIMESTAMP\`)`— the SQLite default format omits milliseconds and uses a space separator rather than`T`, which breaks strict ISO 8601 consumers.

**Relations API:** Define Drizzle relations for IDE navigation and the typed query builder (`db.query.*`), but **do not rely on them for production queries**. The relational query builder does not support all SQLite-specific optimisations (e.g. `RETURNING`, `INSERT OR IGNORE`, `ON CONFLICT DO UPDATE`). Use `db.select().from(...).innerJoin(...)` with explicit joins for all hot-path queries.

```typescript
// src/db/schema.ts — relations block (append after table definitions)
import { relations } from 'drizzle-orm';

export const upstreamServersRelations = relations(upstreamServers, ({ many }) => ({
  envVars: many(upstreamEnvVars),
  headers: many(upstreamHeaders),
  guildLinks: many(guildServers),
  toolCache: many(serverToolCache),
  sessionUpstreams: many(sessionUpstreams),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  guilds: many(agentGuilds),
  directServers: many(agentDirectServers),
  sessions: many(sessions),
}));
```

---

### 5.4.2 Migration Versioning Strategy

Drizzle generates migration files with a timestamp prefix (`0001_<name>.sql`, `0002_<name>.sql`, …). Follow these rules to keep the migration history clean and deployable:

**Numbering convention:** Drizzle auto-assigns sequential numeric prefixes. Never rename a migration file after it has been committed — the Drizzle journal (`drizzle/_journal.json`) tracks files by name, and renaming causes the migration runner to skip or re-run them.

**Each migration is append-only.** Never edit a committed migration file. If a column name was wrong, add a new migration that performs the rename (`ALTER TABLE ... RENAME COLUMN`). If data must be backfilled, add the column with a `DEFAULT` expression or a separate `UPDATE` statement in a new migration.

**Zero-downtime migration rules for SQLite:**
SQLite ALTER TABLE is limited — it does not support `DROP COLUMN` before SQLite 3.35 (included in Node 22 via the bundled `better-sqlite3` build) or `ADD CONSTRAINT`. For complex schema changes, use the SQLite "12-step ALTER TABLE procedure":

1. Create the new table with the correct schema.
2. Copy data from the old table.
3. Drop the old table.
4. Rename the new table.
   All four steps MUST be wrapped in a single transaction within the migration file.

**Rollback strategy:** SQLite does not support transactional DDL rollback for `CREATE TABLE` / `DROP TABLE` across separate transactions. However, because the migration runner wraps each migration in a transaction (`BEGIN / COMMIT`), a migration that fails partway through leaves the database unchanged for that migration. Design migrations so they are idempotent where possible (e.g. `CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`).

There is no automated down-migration in the v1 runtime. If a migration must be rolled back in production, restore from the SQLite file backup taken before the migration ran. Drizzle's `db:migrate` command MUST create a backup of `db.sqlite` before applying any pending migrations: `cp db.sqlite db.sqlite.bak-{timestamp}`. This is enforced in `src/db/migrate.ts`.

**`drizzle.config.ts` — correct content for SQLite + `better-sqlite3`:**

```typescript
// drizzle.config.ts  (mcp-proxy root)
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './dist/db/schema.js', // compiled output, NOT './src/db/schema.ts'
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.MCP_AGGREGATOR_DB_PATH ?? `${process.env.HOME}/.mcp-aggregator/db.sqlite`,
  },
  // Strict mode: fail if schema and DB diverge rather than silently skipping columns.
  strict: true,
  // verbose: true,   // uncomment when debugging migration generation
});
```

**Why `./dist/db/schema.js` not `./src/db/schema.ts`:** `drizzle-kit generate` executes the schema file via `require()`. Running `tsx` at migration-generation time works in development but is brittle in CI and Docker because `tsx` is a dev dependency and must be present in `PATH`. Using the compiled JS output (built by `pnpm build:server`) is always safe. **The build step MUST complete before `pnpm db:generate` or `pnpm db:migrate` are run** — the `package.json` scripts must enforce this order.

```json
"db:generate": "pnpm build:server && drizzle-kit generate",
"db:migrate":  "pnpm build:server && tsx src/db/migrate.ts"
```

**Migration file naming:** Use descriptive suffixes that communicate intent:

```
0001_initial_schema.sql
0002_add_audit_log.sql
0003_session_upstreams_normalize.sql
0004_agent_registration_source.sql
```

---

### 5.4.3 `db/client.ts` Initialization Sequence

The database client must be constructed in a strict, ordered sequence. A single exported `createDb(dbPath: string)` factory function owns this sequence — no module-level side effects, no `export const db = ...` at module scope.

```typescript
// src/db/client.ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type DrizzleDb = ReturnType<typeof createDb>['db'];

export function createDb(dbPath: string): { sqlite: Database.Database; db: DrizzleDb } {
  // 1. Open the file; will create it if it does not exist.
  const sqlite = new Database(dbPath);

  // 2. Apply security permissions — abort if chmod fails.
  //    Must happen before any pragma that writes to the file.
  try {
    chmodSync(dbPath, 0o600);
  } catch (err) {
    throw new Error(`Cannot set db.sqlite permissions to 0600: ${err}`);
  }

  // 3. Required pragmas — order matters:
  //    WAL must be set before foreign_keys (WAL journal writes precede FK checks).
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous   = NORMAL');
  sqlite.pragma('busy_timeout  = 5000');
  sqlite.pragma('cache_size    = -8000'); // 8 MB page cache
  sqlite.pragma('foreign_keys  = ON');
  sqlite.pragma('temp_store    = MEMORY'); // keep temp tables in RAM, not disk
  sqlite.pragma('mmap_size     = 134217728'); // 128 MB memory-mapped I/O (reduces syscall overhead)

  // 4. Wrap in Drizzle — pass the full schema for typed queries.
  const db = drizzle(sqlite, { schema });

  return { sqlite, db };
}
```

**Why return `{ sqlite, db }` together:** The raw `better-sqlite3` handle is needed for three operations that Drizzle does not expose: (a) running raw `PRAGMA` statements after open, (b) WAL checkpoint calls (`sqlite.pragma('wal_checkpoint(TRUNCATE)')`), and (c) the `sqlite.close()` call during graceful shutdown. The `db` handle is used for all application queries. Never import one without the other.

**Pragma ordering notes:**

- `journal_mode = WAL` must come before `synchronous = NORMAL`. Setting `synchronous = NORMAL` without WAL defaults to the rollback journal with partial-sync semantics that may corrupt on OS crash.
- `foreign_keys = ON` must be set on every new connection — SQLite does not persist this setting across connection opens. `better-sqlite3` reuses one connection, but integration tests that call `new Database(':memory:')` will miss it if the initialization sequence is not followed.
- `mmap_size`: set this on the primary data connection only. Do not set it in the test helpers that open `:memory:` databases — it has no effect on in-memory databases and generates a log warning from SQLite.

**WAL checkpoint strategy:** The WAL file grows unbounded unless checkpointed. `PRAGMA synchronous = NORMAL` with WAL mode means SQLite only checkpoints automatically at the default 1000-page threshold. For a long-running process, add a periodic manual checkpoint during idle periods:

```typescript
// Called by a setInterval scheduled every 5 minutes, during periods of low write activity.
function checkpointWal(sqlite: Database.Database): void {
  const result = sqlite.pragma('wal_checkpoint(PASSIVE)') as [
    { busy: number; log: number; checkpointed: number },
  ];
  if (result[0].busy > 0) {
    // Some pages could not be checkpointed because a reader holds a read transaction.
    // This is normal and not an error — the next checkpoint will include them.
    logger.debug('WAL checkpoint: %d pages still busy', result[0].busy);
  }
}
```

Use `PASSIVE` mode (never blocks readers or writers) for the periodic checkpoint. Use `TRUNCATE` mode only during graceful shutdown (step 6 in §16.5), after all connections are closed, to reset the WAL file to zero bytes.

**Graceful close sequence:**

```typescript
export function closeDb(sqlite: Database.Database): void {
  // Checkpoint before close to minimize WAL size on next open.
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  sqlite.close();
}
```

---

### 5.4.4 Transaction Design Patterns — Which Operations Must Be Atomic

`better-sqlite3` transactions are synchronous and automatically roll back on exception. Use `sqlite.transaction(fn)` for all multi-statement operations. The following operations MUST be wrapped in a single transaction:

| Operation                               | Tables touched                                                                                                           | Why atomic                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Agent auto-registration (first connect) | `agents` INSERT OR IGNORE, `agents` UPDATE session_count, `agent_guilds` INSERT (hint), `sessions` INSERT                | Partial writes leave the session table with no parent agent row or a session_count mismatch                         |
| Session open                            | `agents` UPDATE session_count + last_seen_at, `sessions` INSERT, `session_upstreams` INSERT (one row per upstream)       | Session row must exist before upstream rows due to FK                                                               |
| Session close                           | `sessions` UPDATE disconnected_at, `session_upstreams` UPDATE disconnected_at                                            | Both must reflect the same wall time                                                                                |
| `server_tool_cache` replace             | `server_tool_cache` DELETE WHERE server_id, `server_tool_cache` INSERT bulk, `upstream_servers` UPDATE cached_tool_count | Readers must never see a partial tool list between delete and re-insert                                             |
| `PUT /servers/:id/env`                  | `upstream_env_vars` DELETE WHERE server_id, `upstream_env_vars` INSERT bulk                                              | Same as above                                                                                                       |
| YAML sync (`syncFromYaml`)              | Multiple upserts across `upstream_servers`, `guilds`, `agents`, `guild_servers`, `agent_guilds`                          | Config must be consistent at any point a session start might read it                                                |
| Crash recovery                          | `sessions` bulk UPDATE, `session_upstreams` bulk UPDATE                                                                  | Must be consistent — no partially-recovered state                                                                   |
| Session cap eviction                    | `sessions` DELETE + INSERT                                                                                               | Cap DELETE and new row INSERT must be atomic — the table must never transiently have >1001 rows visible to a reader |
| Audit log entry                         | Any write + `audit_log` INSERT                                                                                           | Audit entry and the change it records must commit together                                                          |

**Nested transaction pattern:** `better-sqlite3`'s `.transaction()` does not support true nested transactions (SQLite has `SAVEPOINT` but Drizzle does not expose it). If a function that uses a transaction is called from within another transaction, SQLite reuses the outer transaction. This is safe for the patterns above — callers do not need to detect whether they are inside a transaction. However, do not rely on this behaviour for rollback isolation: an exception in an inner function will roll back the entire outer transaction.

**Drizzle transaction helper:**

```typescript
// Preferred pattern for all multi-statement writes:
const insertSession = db.transaction((params: NewSessionParams) => {
  db.update(agents)
    .set({ sessionCount: sql`session_count + 1`, lastSeenAt: params.now })
    .where(eq(agents.id, params.agentId))
    .run();

  const [session] = db
    .insert(sessions)
    .values({ id: params.sessionId, agentId: params.agentId, connectedAt: params.now })
    .returning()
    .all();

  for (const upstream of params.upstreams) {
    db.insert(sessionUpstreams)
      .values({
        id: generateId(),
        sessionId: session.id,
        serverId: upstream.serverId,
        status: upstream.status,
      })
      .run();
  }

  return session;
});
```

---

### 5.4.5 Query Optimization for the Primary Access Patterns

The three hot-path queries that execute on every session start are:

**1. Agent guild + direct server resolution (called by `resolveServerSet`):**

```sql
-- Resolve all servers for an agent in a single round-trip.
-- The UNION ALL avoids a second query; ORDER BY ensures stable ordering.
SELECT s.*, 'guild' AS via, g.slug AS guild_slug
FROM agent_guilds ag
JOIN guild_servers  gs ON gs.guild_id  = ag.guild_id
JOIN upstream_servers s ON s.id        = gs.server_id
JOIN guilds          g  ON g.id        = ag.guild_id
WHERE ag.agent_id = ?
  AND s.enabled   = 1
ORDER BY ag.added_at ASC, gs.added_at ASC

UNION ALL

SELECT s.*, 'direct' AS via, NULL AS guild_slug
FROM agent_direct_servers ads
JOIN upstream_servers s ON s.id = ads.server_id
WHERE ads.agent_id = ?
  AND s.enabled    = 1
ORDER BY ads.added_at ASC
```

This replaces three separate queries in the `resolveServerSet` algorithm. Because `agent_guilds(agent_id)`, `guild_servers(guild_id)`, and `agent_direct_servers(agent_id)` are all indexed (§5.4 Required indexes), the query plan uses index scans. `EXPLAIN QUERY PLAN` should show no full-table scans.

**Drizzle equivalent:** The `UNION ALL` pattern requires `db.run(sql\`...\`)`with a raw template literal — Drizzle's query builder does not expose`UNION ALL`directly as of drizzle-orm 0.29. This is one of the few cases where a raw SQL helper is acceptable. Wrap it in`ConfigStore.resolveAgentServers(agentId: string): ServerWithVia[]` so the raw SQL is isolated to one method.

**2. Static tool list for `GET /agents/:id/tools`:**

```sql
SELECT
  stc.tool_name,
  stc.tool_description,
  stc.input_schema,
  stc.cached_at,
  s.alias,
  s.id        AS server_id,
  s.enabled,
  via.via_type,
  via.guild_slug
FROM (
  -- Guild-assigned servers
  SELECT gs.server_id, 'guild' AS via_type, g.slug AS guild_slug
  FROM agent_guilds ag
  JOIN guild_servers gs ON gs.guild_id = ag.guild_id
  JOIN guilds        g  ON g.id        = ag.guild_id
  WHERE ag.agent_id = ?
  UNION
  -- Direct-assigned servers (UNION deduplicates if same server in guild + direct)
  SELECT ads.server_id, 'direct', NULL
  FROM agent_direct_servers ads
  WHERE ads.agent_id = ?
) via
JOIN upstream_servers  s   ON s.id        = via.server_id
JOIN server_tool_cache stc ON stc.server_id = s.id
ORDER BY via.via_type, s.alias, stc.tool_name
```

Using `UNION` (not `UNION ALL`) here performs deduplication of servers that appear in both a guild and as a direct assignment, matching the `resolveServerSet` semantics.

**3. Dashboard active session count (called on every `/health` and UI poll):**

```sql
SELECT COUNT(*) FROM sessions WHERE disconnected_at IS NULL
```

The `(agent_id, disconnected_at)` index covers this. However, as this query is called at 5s UI poll intervals, keep it lightweight. Add a partial index specifically for active sessions:

```sql
CREATE INDEX IF NOT EXISTS sessions_active_idx
  ON sessions (connected_at DESC)
  WHERE disconnected_at IS NULL;
```

Drizzle does not yet support partial index syntax in its `index()` builder. Use `sql\`CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions (connected_at DESC) WHERE disconnected_at IS NULL\`` in the initial migration file.

---

### 5.4.6 The `server_tool_cache` as a Write-Through Cache

The `server_tool_cache` table functions as a write-through cache — it is populated on each successful upstream connection and read by static tool list endpoints without making live connections. Several design constraints preserve cache integrity:

**Atomic replacement (enforced — see §5.4):** The delete-then-insert pattern means there is a brief window during which the table contains zero rows for that server. This window is inside a transaction and therefore invisible to concurrent readers. Any reader that held a read transaction before the write started will see either the old rows or the new rows in their entirety — never an empty set mid-replacement.

**Staleness tracking:** `cached_at` is written with each replacement. Consumers of the cache MUST check `cached_at` and flag servers where `cached_at < NOW() - staleness_threshold` as stale. The `GET /agents/:id/tools` and `GET /guilds/:id/tools` responses include a `stale_servers` array (§5.4 Staleness indicator). Do not serve stale cache data silently.

**Cache miss vs. server with zero tools:** A server with no rows in `server_tool_cache` may mean (a) it has never successfully connected, or (b) it connected but returned zero tools. Distinguish these cases using `upstream_servers.last_connected_at`:

- `last_connected_at IS NULL` → never connected → report in `uncached_servers`.
- `last_connected_at IS NOT NULL` AND no cache rows → connected but returned zero tools → report as a server with `tool_count: 0`, not in `uncached_servers`.

This distinction requires a LEFT JOIN in the static tool list query:

```sql
SELECT s.alias, s.id, s.last_connected_at, COUNT(stc.id) AS tool_count
FROM upstream_servers s
LEFT JOIN server_tool_cache stc ON stc.server_id = s.id
WHERE s.id IN (/* resolved server set for this agent/guild */)
GROUP BY s.id
```

**`cached_tool_count` denormalization:** `upstream_servers.cached_tool_count` is a denormalized count that mirrors `COUNT(*) FROM server_tool_cache WHERE server_id = ?`. It must be updated atomically with the cache replacement. This redundancy exists so the server list endpoint (`GET /servers`) can show tool counts without joining `server_tool_cache`. Keep it consistent — never update `cached_tool_count` in isolation without also updating the cache.

---

### 5.4.7 Soft-Delete vs. Hard-Delete Tradeoffs

The spec currently uses hard-delete with `SET NULL` on `sessions.agent_id` (§5.4 Foreign key cascade rules). This section clarifies the tradeoff and documents where soft-delete would be preferable.

**Hard-delete (current approach for agents, guilds, servers):**

- Pros: Simple. No need to filter `deleted_at IS NULL` on every query. No stale data accumulation.
- Cons: Orphans the `sessions.agent_id` (SET NULL) — session history loses attribution. Cascade-deletes `agent_guilds`, `agent_direct_servers` — guild memberships are unrecoverable.

**Soft-delete recommendation for upstream servers:**

Because disabling a server (`enabled = 0`) already serves as a soft-disable, deleting a server causes irreversible loss of the `server_tool_cache` entries and `session_upstreams` history. Consider adding `deleted_at TEXT NULL` to `upstream_servers` and filtering `WHERE deleted_at IS NULL` in all queries. The alias uniqueness constraint must then be on `(alias) WHERE deleted_at IS NULL` — a partial unique index, which Drizzle cannot express natively (use a raw migration SQL statement).

**Decision for v1:** Hard-delete is retained for v1 to keep the implementation simple. The `yaml_managed` guard (§5.4 `yaml_managed` behaviour) prevents accidental deletion of YAML-managed entities via the REST API. If a soft-delete requirement emerges from operator feedback (e.g. "we deleted a server by accident"), add `deleted_at` in a follow-up migration without breaking existing queries.

**Audit log as the recovery mechanism:** For v1, the `audit_log` table (§9.6) is the primary recovery mechanism for accidental deletes. Because every DELETE generates an audit entry with `payload` containing the entity's data at deletion time, deleted entities can be reconstructed manually. This is an acceptable tradeoff given v1's single-operator, local-deployment context.

---

### 5.4.8 Audit Log Table — Design and Write Patterns

The `audit_log` table (§9.6) is append-only and write-heavy. Its design must support both the write path (latency-sensitive — must not slow down API responses) and the read path (queries for recent events on a specific resource).

**Structural improvements to the table defined in §9.6:**

```typescript
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(), // e.g. 'server.created'
    actor: text('actor').notNull(), // source IP or 'operator'
    targetId: text('target_id').notNull(),
    targetType: text('target_type', {
      enum: ['agent', 'guild', 'server', 'session'],
    }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<AuditPayload>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    targetIdx: index('audit_log_target_idx').on(t.targetType, t.targetId),
    createdAtIdx: index('audit_log_created_at_idx').on(t.createdAt),
    actorIdx: index('audit_log_actor_idx').on(t.actor),
  })
);

export type AuditPayload = {
  before?: Record<string, unknown>; // snapshot of affected fields before the change
  after?: Record<string, unknown>; // snapshot of affected fields after the change
  keys_updated?: string[]; // for env/header writes: only key names, never values
  reason?: string; // for force-close, disable, etc.
};
```

**Write pattern — deferred audit writes:** Audit log writes are lower priority than the mutation they describe. The recommended pattern is to write the audit row in the same transaction as the mutation (ensuring the audit entry is always present if the mutation committed), but use a lightweight helper that never throws:

```typescript
function logAudit(
  db: DrizzleDb,
  entry: Omit<typeof auditLog.$inferInsert, 'id' | 'createdAt'>
): void {
  try {
    db.insert(auditLog)
      .values({
        id: generateId(),
        createdAt: new Date().toISOString(),
        ...entry,
      })
      .run();
  } catch (err) {
    // Audit log failure MUST NOT fail the originating mutation.
    // Log at WARN — the transaction already committed; this is a secondary concern.
    logger.warn({ err }, 'Failed to write audit log entry');
  }
}
```

Call `logAudit` inside the same `db.transaction()` block as the mutation. If the outer transaction rolls back, the audit entry also rolls back (correct). If only the `logAudit` call throws (e.g. disk full), the `try/catch` prevents the mutation from being rolled back.

**Audit log pruning:** The audit log has no cap in v1. It will grow indefinitely. Add a background pruning job (called weekly, not on every request) that deletes entries older than 90 days. The `createdAt` index makes this efficient:

```typescript
// Prune audit log entries older than retentionDays (default 90)
function pruneAuditLog(sqlite: Database.Database, retentionDays = 90): number {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const stmt = sqlite.prepare('DELETE FROM audit_log WHERE created_at < ?');
  const result = stmt.run(cutoff);
  return result.changes;
}
```

**Index on `(created_at)` is essential** for the prune query — without it, the DELETE requires a full table scan on a potentially large table, blocking writes for seconds.

---

### 5.4.9 Views and CTEs for Complex Queries

SQLite views provide a named shortcut for frequently-composed queries but are not materialized — they execute as subqueries at query time. Use them selectively where they reduce code duplication in the application layer without hiding performance-critical joins.

**Recommended view: `v_agent_effective_servers`**

This view encapsulates the guild + direct server resolution logic that is repeated across `GET /agents/:id/tools`, the dashboard, and `resolveServerSet`. Creating it as a view ensures the resolution logic is defined in one place (the schema) rather than scattered across application code.

```sql
-- src/db/migrations/0001_initial_schema.sql (include in initial migration)
CREATE VIEW IF NOT EXISTS v_agent_effective_servers AS
SELECT
  ag.agent_id,
  s.id          AS server_id,
  s.alias,
  s.transport_type,
  s.enabled,
  'guild'       AS via_type,
  g.slug        AS guild_slug,
  ag.added_at   AS agent_added_at,
  gs.added_at   AS guild_server_added_at
FROM agent_guilds      ag
JOIN guild_servers      gs ON gs.guild_id  = ag.guild_id
JOIN upstream_servers   s  ON s.id         = gs.server_id
JOIN guilds             g  ON g.id         = ag.guild_id

UNION

SELECT
  ads.agent_id,
  s.id,
  s.alias,
  s.transport_type,
  s.enabled,
  'direct',
  NULL,
  ads.added_at,
  ads.added_at
FROM agent_direct_servers ads
JOIN upstream_servers s ON s.id = ads.server_id;
```

Usage:

```sql
SELECT * FROM v_agent_effective_servers
WHERE agent_id = ? AND enabled = 1
ORDER BY agent_added_at ASC, guild_server_added_at ASC;
```

**Note on Drizzle and views:** Drizzle ORM does not generate migrations for view DDL. Views MUST be added as raw SQL in the migration files, not via the Drizzle schema API. The Drizzle schema file (`schema.ts`) should not reference the view — query it directly with `db.run(sql\`SELECT ... FROM v_agent_effective_servers WHERE ...\`)` or define a typed wrapper:

```typescript
// src/db/views.ts
export function queryAgentEffectiveServers(
  sqlite: Database.Database,
  agentId: string
): AgentEffectiveServerRow[] {
  return sqlite
    .prepare(
      'SELECT * FROM v_agent_effective_servers WHERE agent_id = ? AND enabled = 1 ORDER BY agent_added_at ASC, guild_server_added_at ASC'
    )
    .all(agentId) as AgentEffectiveServerRow[];
}
```

**CTE pattern for the session cap DELETE:** The session cap logic (§5.4 `sessions`) is complex enough to warrant a CTE for readability, and `better-sqlite3` supports CTEs:

```sql
WITH eviction_candidates AS (
  SELECT id FROM sessions
  WHERE disconnected_at IS NOT NULL          -- prefer evicting disconnected sessions
  ORDER BY connected_at ASC
  LIMIT MAX(0, (SELECT COUNT(*) FROM sessions) - 999)
)
DELETE FROM sessions WHERE id IN (SELECT id FROM eviction_candidates);
```

This CTE version is more legible than the subquery in §5.4 and explicitly limits the DELETE to disconnected sessions only (never evicting active sessions), which is the intended semantics.

---

### 5.4.10 SQLite-Specific Pitfalls with Drizzle ORM

The following pitfalls are specific to the `better-sqlite3` + Drizzle combination and have caused production bugs in similar architectures. Each MUST be explicitly reviewed during implementation:

**1. `RETURNING` clause requires Drizzle 0.29+.** Older Drizzle versions for SQLite silently ignore `.returning()` and return `undefined`. Always verify the installed Drizzle version supports `RETURNING` for SQLite before relying on it for auto-generated IDs or timestamps.

**2. `better-sqlite3` is synchronous; Drizzle SQLite calls are also synchronous.** Never `await` a Drizzle SQLite query — it returns a value directly. Adding `await` silently converts the return value to a Promise that resolves immediately, masking type errors. The TypeScript types for `drizzle-orm/better-sqlite3` reflect this correctly, but `any` casts or implicit type assertions can hide the error.

**3. Integer overflow in session_count.** SQLite integers are 64-bit signed but `better-sqlite3` returns JavaScript numbers (53-bit safe integers). An agent with `session_count` exceeding `Number.MAX_SAFE_INTEGER` (9 quadrillion) would produce incorrect values. This is not a practical concern for v1 but warrants a note: if `session_count` is used for display only, treat it as an opaque counter and do not perform arithmetic on it in JavaScript.

**4. Foreign key enforcement is per-connection.** `PRAGMA foreign_keys = ON` is not persisted; it applies only to the connection that issued it. In integration tests that open a second `:memory:` connection (e.g. to inspect the database state), that second connection MUST also set `PRAGMA foreign_keys = ON` before any write — otherwise FK violations introduced by test setup code will silently succeed.

**5. `INSERT OR IGNORE` does not trigger `RETURNING`.** Use `INSERT OR IGNORE ... RETURNING` only if you need to distinguish "row was inserted" from "row already existed". SQLite's `RETURNING` clause returns rows only for rows that were actually inserted, not for rows that were ignored. Use `changes()` (from `better-sqlite3`'s `RunResult`) to check whether the insert was a no-op.

**6. WAL mode and `db.sqlite-shm` / `db.sqlite-wal` files.** When `PRAGMA journal_mode = WAL` is set, SQLite creates companion `-shm` and `-wal` files alongside `db.sqlite`. Docker volume mounts, Kubernetes PVCs, and backup tools must include these files. A backup of only `db.sqlite` without `db.sqlite-wal` is inconsistent if a transaction is in progress. Use `sqlite.pragma('wal_checkpoint(FULL)')` before taking a backup to ensure all WAL pages are flushed to the main file.

**7. `drizzle-kit push` vs. `drizzle-kit migrate` in tests.** Integration tests use `drizzle-kit push` against `:memory:` (§3.2 Testing strategy). `push` applies the current schema directly without generating migration files — it is correct for test setup but MUST NOT be used in production. The production startup code (`src/db/migrate.ts`) MUST use `drizzle-kit migrate` (or the programmatic `migrate()` from `drizzle-orm/better-sqlite3/migrator`), not `push`.

```typescript
// src/db/migrate.ts — production migration runner
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb } from './client.js';
import path from 'path';

export async function runMigrations(dbPath: string): Promise<void> {
  const { db, sqlite } = createDb(dbPath);
  try {
    migrate(db, {
      migrationsFolder: path.join(__dirname, 'migrations'),
    });
  } finally {
    sqlite.close();
  }
}
```

**8. Column name casing.** Drizzle maps camelCase TypeScript property names to snake_case SQL column names by convention, but this mapping is only applied if the column is declared with the snake_case name in the schema (e.g. `text('created_at')`). If you accidentally declare `text('createdAt')`, Drizzle uses `createdAt` as the actual SQL column name, which conflicts with the migration-generated column `created_at`. Always use snake_case SQL column names in schema declarations.

### 5.5 Web UI

Single-page React app served at `/`. **Primary purpose: observability.** Configuration is managed via `mcp.yaml`; the web UI tells you what is actually happening right now. There are no create/edit config forms — the UI is read-heavy, with the only write actions being operational (force-close a session, globally disable/enable an upstream).

**Design principle:** An operator opening the UI at any time should immediately understand: which agents are connected, what tools they have, whether any upstreams are unhealthy, and what has happened recently.

**Pages:**

| Path           | Purpose                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `/`            | Dashboard — live agent status, active sessions, upstream health                                    |
| `/agents`      | Agent list — connection state, guild badges, tool count, last seen                                 |
| `/agents/:id`  | Agent detail — full tool list with source attribution, session history, upstream status per server |
| `/guilds`      | Guild list — server count, agent count, tool count                                                 |
| `/guilds/:id`  | Guild detail — member servers, member agents, full tool preview                                    |
| `/servers`     | Server list — transport type, enabled state, which guilds use it                                   |
| `/servers/:id` | Server detail — config (from YAML), live connection status across sessions, recent errors          |
| `/sessions`    | Session monitor — live and recent sessions, per-upstream connection status                         |
| `/tools`       | Tool browser — full tool catalog, filterable by guild/server/agent                                 |

**XSS prevention requirements:** All user-controlled string values rendered in the React UI MUST be treated as untrusted text:

- `display_name`: max 200 chars, printable Unicode only (no control chars), validated at API write time; rejected with 422 if over length or contains control characters.
- `clientInfo.name` / `clientInfo.version`: truncated to 200 chars before storage. Never rendered as raw HTML — always as text content.
- `upstream_statuses`, error messages from upstreams: rendered as plain text, never `dangerouslySetInnerHTML`.
- `tool_description`, `input_schema`: rendered as plain text. `input_schema` displayed as formatted JSON (`JSON.stringify` output), never evaluated.
- Guild `color`: validated at write time as exactly matching `^#[0-9a-fA-F]{6}$`. Rejected with 422 otherwise. Applied only as a CSS hex color value, never as a style attribute containing arbitrary CSS.
- The React app MUST NOT use `dangerouslySetInnerHTML` for any field sourced from the database or upstream connections.

**Polling behaviour constraints:**

- Auto-refetch is paused when the browser tab is not visible (using the `visibilitychange` API / TanStack Query `refetchIntervalInBackground: false`). This prevents background tabs from generating unnecessary SQLite read traffic.
- On three consecutive failed fetches (network error or 5xx), refetch interval backs off to 30s with jitter (`±5s`) and remains there until a successful fetch.
- Dashboard summary stats (`/health` endpoint) are fetched at a coarser interval (30s) since they are less time-sensitive. The session monitor page retains the 5s interval while visible.

### 5.6 REST API

At `/api`. Detailed in §9.

### 5.7 Component Coupling Map

The allowed dependency directions are strictly layered. Any dependency that points upward (toward the entry point) or sideways between sibling components is a coupling violation.

```
                         ┌─────────────────────────────────────┐
                         │         Entry point (bin/)          │
                         │  Constructs and wires all components │
                         └──────────────┬──────────────────────┘
                                        │ constructs ▼
          ┌──────────────────────────────────────────────────────────┐
          │             Application layer                            │
          │  ┌──────────────────┐   ┌───────────────────────────┐   │
          │  │  Express app     │   │   AggregatorEngine        │   │
          │  │  (http.ts)       │   │   (engine.ts)             │   │
          │  │  REST API routes │   │   Session lifecycle        │   │
          │  │  MCP handler     │   │   Routing + namespacing    │   │
          │  └────────┬─────────┘   └─────────────┬─────────────┘   │
          └───────────│─────────────────────────────│────────────────┘
                      │ depends on ▼                │ depends on ▼
          ┌───────────────────────┐    ┌────────────────────────────┐
          │   Service layer       │    │   Service layer            │
          │   IConfigStore        │    │   IUpstreamManager         │
          │   (SqliteConfigStore) │    │   (UpstreamConnManager)    │
          └───────────┬───────────┘    └────────────┬───────────────┘
                      │ depends on ▼                │ depends on ▼
          ┌───────────────────────┐    ┌────────────────────────────┐
          │   Infrastructure      │    │   Infrastructure           │
          │   better-sqlite3      │    │   child_process.spawn      │
          │   drizzle-orm         │    │   @modelcontextprotocol/sdk│
          └───────────────────────┘    └────────────────────────────┘

          ┌───────────────────────────────────────────────────────────┐
          │   Cross-cutting (used by all layers above)                │
          │   IEventBus (TypedEventBus)                               │
          │   IConfigLoader (YamlConfigLoader + chokidar)             │
          └───────────────────────────────────────────────────────────┘
```

**Prohibited couplings:**

| Prohibited                                                          | Reason                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `AggregatorEngine` → Express `Request`/`Response` types             | Engine is HTTP-agnostic; HTTP concerns live in the MCP handler                                                           |
| `AggregatorEngine` → drizzle-orm / better-sqlite3                   | Engine uses `IConfigStore`; never raw SQL                                                                                |
| `IUpstreamManager` → `IConfigStore`                                 | Upstream manager receives `ResolvedServerConfig` values; it never reads the DB directly                                  |
| REST API route handlers → `IUpstreamManager`                        | Route handlers use `IConfigStore` for reads and `IAggregatorEngine` for session ops; never the upstream manager directly |
| `IConfigLoader` → `IConfigStore`                                    | Config loader parses files and returns `ResolvedConfig`; DB sync is done by the entry point after loading                |
| Any layer → `process.env` (outside entry point and `IConfigLoader`) | Env var reads are centralised in the config loader; all other code uses `ResolvedConfig` values                          |

---

## 6. Agent Connection Flow

### 6.1 First connection (new agent)

```
Agent                           Proxy                         Config Store
  │                               │                               │
  │  POST /mcp/agents/claude-qa-1 │                               │
  │  initialize { clientInfo: ... }│                               │
  │──────────────────────────────►│                               │
  │                               │  SELECT * FROM agents         │
  │                               │  WHERE id = 'claude-qa-1'    │
  │                               │──────────────────────────────►│
  │                               │◄── (not found) ───────────────│
  │                               │                               │
  │                               │  INSERT INTO agents (id, ...) │
  │                               │  session_count = 1            │
  │                               │──────────────────────────────►│
  │                               │                               │
  │                               │  [check clientInfo for guild  │
  │                               │   hint, auto-assign if match] │
  │                               │                               │
  │◄── initialize response ───────│                               │
  │    (empty tools if no guild)  │                               │
  │                               │                               │
```

**Concurrent first-connection handling:** Agent auto-registration MUST use `INSERT OR IGNORE INTO agents (...) VALUES (...); UPDATE agents SET session_count = session_count + 1, last_seen_at = ? WHERE id = ?` (or an equivalent `INSERT ... ON CONFLICT(id) DO UPDATE SET session_count = session_count + 1` upsert). This is atomic under SQLite's serialised write model and handles concurrent first-connections correctly: the first writer inserts the row; the second writer's INSERT is a no-op due to the UNIQUE constraint on `id`, but both writers increment `session_count`.

### 6.2 Subsequent connection (multi-guild agent)

```
Agent                           Proxy                         Upstreams
  │                               │                               │
  │  POST /mcp/agents/garry       │                               │
  │  initialize { clientInfo: ... }│                               │
  │──────────────────────────────►│                               │
  │                               │  agent.guilds = [ceo,         │
  │                               │    developer]                 │
  │                               │  + direct = [garry-crm]       │
  │                               │  deduplicate servers          │
  │                               │  servers: [board, github,     │
  │                               │    deploy, ide, garry-crm]    │
  │                               │                               │
  │                               │──── initialize ──────────────►│ (all 5, parallel)
  │                               │◄─── capabilities ─────────────│
  │                               │                               │
  │                               │  merge + namespace            │
  │                               │  upsert server_tool_cache     │
  │                               │  record session               │
  │◄── initialize response ───────│                               │
  │    {                          │                               │
  │      "protocolVersion": "2025-06-18",                        │
  │      "capabilities": {        │                               │
  │        "tools": { "listChanged": true }                      │
  │      },                       │                               │
  │      "serverInfo": { "name": "mcp-aggregator", "version": "1.0.0" }
  │    }                          │                               │
  │                               │                               │
  │  tools/list                   │                               │
  │──────────────────────────────►│                               │
  │◄── [board__*, github__*, deploy__*, ide__*, garry-crm__*]─────│
```

### 6.3 Guild membership change (while agent is connected)

1. Operator edits `mcp.yaml` (adds/removes guild from the agent's `guilds` list) and saves, triggering a config reload. Alternatively: `POST /api/agents/garry/guilds` or `DELETE /api/agents/garry/guilds/:guild-id` via REST API for scripted use.
2. Proxy computes new server set (deduplicated union of new guild list + direct assignments)
3. Disconnects upstreams no longer needed, connects newly required upstreams
4. Broadcasts `notifications/tools/list_changed` to all active sessions of that agent
5. Agent calls `tools/list` and gets the updated tool set

### 6.4 Untracked multi-guild connection

```
Agent → POST /mcp/guilds/qa-engineer,developer,ceo
```

1. Proxy splits slugs by comma (accepts both raw `,` and percent-encoded `%2C`), resolves each guild's servers
2. Deduplicates (same server in multiple guilds = one connection)
3. Serves union of all tools — no agent record created
4. Session recorded with `guild_slugs: ["qa-engineer", "developer", "ceo"]`

### 6.5 Session Close Sequence

The following covers a clean session close (HTTP stream closed by client). The same sequence applies to a force-close via `DELETE /sessions/:id`, except the close is initiated by the API handler instead of stream disconnect detection.

```
HTTP Layer          AggregatorEngine         UpstreamManager        DB (IConfigStore)
     │                    │                        │                       │
     │ stream close       │                        │                       │
     │ detected           │                        │                       │
     │───────────────────►│                        │                       │
     │                    │ session → DRAINING     │                       │
     │                    │ reject new requests    │                       │
     │                    │                        │                       │
     │                    │ [wait: in-flight ref   │                       │
     │                    │  count → 0, or timeout]│                       │
     │                    │                        │                       │
     │                    │ disconnect(handle)     │                       │
     │                    │───────────────────────►│                       │
     │                    │                        │ SIGTERM to subprocesses│
     │                    │                        │ (stdio only)          │
     │                    │                        │ [3s grace → SIGKILL]  │
     │                    │                        │ close HTTP streams    │
     │                    │                        │ (streamablehttp/sse)  │
     │                    │◄── all handles closed ─│                       │
     │                    │                        │                       │
     │                    │ session → CLOSED       │                       │
     │                    │ sessions.remove(id)    │                       │
     │                    │────────────────────────────────────────────────►
     │                    │                        │  UPDATE sessions SET  │
     │                    │                        │  disconnected_at = NOW│
     │                    │                        │  UPDATE session_      │
     │                    │                        │  upstreams SET        │
     │                    │                        │  disconnected_at=NOW  │
     │                    │ publish('session.closed', ...)                 │
```

**Graceful shutdown (SIGTERM to proxy):** On `SIGTERM`, the entry point calls `engine.closeSession()` for every active session concurrently, then waits up to 10 seconds for all sessions to reach `CLOSED` before calling `process.exit(0)`. Sessions that have not closed within the 10s window have their upstream processes SIGKILL'd and their DB rows written with `disconnected_at = NOW()` before exit.

---

## 7. Tool Namespacing

All tool names are prefixed with the upstream server's `alias` using double-underscore as separator.

**Format:** `{alias}__{original_tool_name}`

**Examples:**

- `github__create_issue`
- `browser__navigate`
- `slack__send_message`

Rules:

- `alias` must match `[a-z][a-z0-9-]*` (letters, digits, hyphens; no underscores). Excluding underscores makes the `__` separator unambiguous and keeps `mcp+{alias}://` a valid URI scheme per RFC 3986 §3.1.
- Original tool name preserved exactly
- Each tool gets an annotation: `x-mcp-aggregator-source: { alias, server_id, guild_id }`
- Tool call routing: split on the **first** `__` → `alias` prefix → look up upstream connection → forward with original name (preserving any `__` within the original tool name)

Same pattern for **prompts**: `{alias}__{prompt_name}`

**Prompt routing:** `prompts/get` routing follows the identical split-on-first-`__` rule as `tools/call`: the alias prefix is stripped and the original prompt name is forwarded to the owning upstream. Any `__` characters within the original prompt name are preserved.

**`prompts/list` aggregation:** The proxy calls `prompts/list` on every connected upstream that advertises the `prompts` capability, applies `{alias}__{original_name}` prefixing to each returned prompt name, and returns the merged list. Pagination cursors are followed to exhaustion per upstream before merging.

**Resource URI encoding:** The full original URI string is percent-encoded and placed in the path of a `mcp+{alias}:` URI:

```
mcp+{alias}:/{percent-encoded original URI}
```

Examples:

- `file:///tmp/foo.ts` → `mcp+github:/file%3A%2F%2F%2Ftmp%2Ffoo.ts`
- `doc-123` → `mcp+github:/doc-123`
- `urn:uuid:abc` → `mcp+github:/urn%3Auuid%3Aabc`

On inbound `resources/read`:

1. Match `mcp+{alias}:` scheme to identify upstream
2. Percent-decode the path to recover the exact original URI string
3. Forward the decoded URI in the `resources/read` request to the upstream

This encoding is lossless for all URI forms (path-only, URNs, opaque IDs, absolute URIs). The choice of single-slash path (not `//host/path`) avoids misinterpreting the original URI's content as a hostname.

> **Why not `upstream://{alias}/...`?** The `upstream` scheme is unregistered and some clients sanitize or reject URIs with unknown schemes. `mcp+{alias}://` is equally non-standard but the `mcp+` prefix visually signals its origin and avoids accidental collisions with real URIs.

---

## 8. Hot Reload

Any config change triggers a reload cycle for affected agents:

| Change                                  | Affected agents                                |
| --------------------------------------- | ---------------------------------------------- |
| Add server to guild                     | All agents with that guild in their membership |
| Remove server from guild                | All agents with that guild in their membership |
| Agent guild added                       | That agent only                                |
| Agent guild removed                     | That agent only                                |
| Add agent direct server                 | That agent only                                |
| Remove agent direct server              | That agent only                                |
| Enable/disable upstream server globally | All agents using it (across all guilds/direct) |
| Upstream server config change           | All agents using it (reconnect)                |

**File change debounce:** The chokidar watcher MUST debounce `change` events with a trailing delay of `MCP_AGGREGATOR_RELOAD_DEBOUNCE_MS` (default: `300` ms). Only the last event within a debounce window triggers a reload. This prevents multiple rapid saves (common with editors that write via temp-file rename or auto-save on every keystroke) from triggering redundant reconnect cycles.

**Reload cycle:**

1. REST API writes change to SQLite
2. Publishes change event to in-process event bus (keyed by affected agent IDs)
3. Aggregator Engine receives event, reconnects affected upstreams per session
4. Broadcasts `notifications/tools/list_changed` to all active sessions of affected agents **only after** all upstream connection attempts for the reload cycle have resolved (connected or error/skipped)
5. Agents re-fetch `tools/list`, see updated tool set

**Notification ordering guarantee:** `notifications/tools/list_changed` is broadcast ONLY AFTER all upstream connection attempts for the reload cycle have resolved (connected or error/skipped). This ensures the agent's subsequent `tools/list` call returns a stable, complete set. If a newly added upstream fails to connect during the reload, the notification is still sent; the agent's `tools/list` will reflect only successfully connected upstreams. The failed upstream is recorded as `error` in `upstream_statuses`.

**Two reload trigger paths — same outcome:**

1. **REST API write:** `POST /api/agents/:id/guilds` → writes to SQLite → publishes event to in-process event bus → Aggregator Engine reconnects.
2. **YAML file save:** chokidar detects change → re-parses mcp.yaml → diffs against current in-memory config → for each changed entity, publishes the same event to the same in-process event bus → Aggregator Engine reconnects.

Both paths converge on the same event bus and the same reconnect logic. The YAML path additionally updates the SQLite records to match before publishing the event.

**What can be changed via REST API vs YAML only:**

| Change type                       | REST API                                                         | YAML |
| --------------------------------- | ---------------------------------------------------------------- | ---- |
| Agent guild membership            | Yes (auto-registered agents; YAML-defined overwritten on reload) | Yes  |
| Agent direct servers              | Yes                                                              | Yes  |
| Server enable/disable             | Yes (`POST /servers/:id/enable\|disable`)                        | No   |
| Server transport/command/args/url | No (read-only via API)                                           | Yes  |

**In-flight calls during reload:** If a `tools/call` is in-flight against an upstream that is being torn down, the upstream connection is closed after the response returns (or after the upstream's `timeout_ms` if no response arrives). The call is not cancelled mid-flight. Any `tools/call` that arrives for a removed upstream _after_ the reload cycle completes returns `isError: true` per §12.5.

**In-flight call tracking:** The connection manager MUST maintain a per-upstream-connection reference count of outstanding `tools/call` requests. When a reload triggers teardown of an upstream connection, the teardown is deferred until the reference count reaches 0, or until the upstream's configured `timeout_ms` elapses (whichever comes first). During this drain window, new `tools/call` requests targeting the old connection are rejected immediately with `isError: true` and message `"Upstream 'X' is being reloaded"`. New requests for that upstream are held in a 500 ms queue pending the new connection coming up; if the new connection does not come up within that queue window, the held calls are rejected.

### 8.1 Hot Reload Sequence Diagram

The following sequence covers the YAML-save hot reload path end-to-end. The REST API write path is identical from step 4 onward.

```
Operator         chokidar      ConfigLoader      ConfigStore      EventBus        AggregatorEngine   Agent(s)
   │                │               │                 │               │                  │               │
   │ saves mcp.yaml │               │                 │               │                  │               │
   │───────────────►│               │                 │               │                  │               │
   │                │ change event  │                 │               │                  │               │
   │                │ (debounced)   │                 │               │                  │               │
   │                │──────────────►│                 │               │                  │               │
   │                │               │ load+validate   │               │                  │               │
   │                │               │ (symlink check) │               │                  │               │
   │                │               │  diff vs prev   │               │                  │               │
   │                │               │ [parse error → retain prev, log ERROR, stop]       │               │
   │                │               │─────────────────►               │                  │               │
   │                │               │  syncFromYaml() │               │                  │               │
   │                │               │                 │ upsert rows   │                  │               │
   │                │               │                 │ yaml_managed=1│                  │               │
   │                │               │                 │───────────────►                  │               │
   │                │               │                 │  publish(config.changed,         │               │
   │                │               │                 │    { affectedAgentIds })          │               │
   │                │               │                 │               │─────────────────►│               │
   │                │               │                 │               │                  │ reloadSessions│
   │                │               │                 │               │                  │ for each sess │
   │                │               │                 │               │                  │ → RELOADING   │
   │                │               │                 │               │                  │ drain old     │
   │                │               │                 │               │                  │ connect new   │
   │                │               │                 │               │                  │ → ACTIVE      │
   │                │               │                 │               │                  │──────────────►│
   │                │               │                 │               │                  │ notifications/│
   │                │               │                 │               │                  │ tools/list_   │
   │                │               │                 │               │                  │ changed       │
```

### 8.2 Event Bus Design

The in-process event bus (`src/events/bus.ts`) is a **typed wrapper** over Node's `EventEmitter`. Using raw `EventEmitter` with string event names and untyped payloads throughout the codebase leads to silent mismatches. The wrapper enforces the event catalog at compile time.

**Why a local EventEmitter is sufficient for v1:** The proxy is a single-process service. There is no need for a distributed message broker. All consumers (the aggregator engine, the API layer for SSE push to the web UI) run in the same Node.js event loop. If v2 adds horizontal scaling (multiple proxy replicas sharing a database), the `IEventBus` interface can be re-implemented over Redis Pub/Sub or similar — the rest of the codebase remains unchanged.

**Typed event catalog (`src/events/bus.ts`):**

```typescript
export interface EventMap {
  /** Fired after YAML sync or REST API write; engine calls reloadSessions */
  'config.changed': {
    affectedAgentIds: Set<string>; // empty set = all agents (e.g. global server disable)
    changedServerIds: Set<string>;
    source: 'yaml' | 'api';
  };

  /** Fired by upstream manager when a keep-alive ping fails */
  'upstream.error': {
    sessionId: string;
    serverId: string;
    alias: string;
    error: Error;
  };

  /** Fired by upstream manager when a previously-errored upstream recovers */
  'upstream.recovered': {
    sessionId: string;
    serverId: string;
    alias: string;
  };

  /** Fired by aggregator engine when a session transitions state */
  'session.state_changed': {
    sessionId: string;
    agentId: string | null;
    from: SessionState;
    to: SessionState;
  };

  /** Fired after a session is fully closed (for UI SSE push) */
  'session.closed': {
    sessionId: string;
    agentId: string | null;
    reason: CloseReason;
  };
}
```

**Ordering and backpressure:** All event handlers MUST be synchronous or return a `Promise` that is awaited by the emitter. The bus wrapper MUST call handlers sequentially (not fire-and-forget) to preserve ordering guarantees: specifically, `config.changed` must be fully processed (all affected sessions reloaded) before a second `config.changed` for the same set of agents begins. Concurrent reloads for disjoint agent sets are permitted. Implementation uses a per-agent-set FIFO queue in the engine.

**Error isolation:** An unhandled exception in one subscriber MUST NOT prevent other subscribers from receiving the event. The bus wrapper catches exceptions per subscriber, logs them at `ERROR` level, and continues to the next subscriber.

**Web UI SSE push:** The REST API layer subscribes to `session.state_changed` and `upstream.error` events to push real-time updates to the UI's `/api/events` Server-Sent Events endpoint (v2 candidate). In v1, the UI polls at 5s intervals; the event bus subscription point is reserved but the SSE endpoint is not required.

---

## 9. REST API Specification

Base URL: `http://localhost:4000/api`

**Usage pattern:** The REST API primarily serves the web UI's observability reads (GET endpoints). Write endpoints exist for scripted / CI use cases — e.g. programmatically assigning guilds to an agent from a deploy script, or force-closing a session. The web UI does not expose create/edit config forms; that is done via `mcp.yaml`.

> **YAML precedence warning:** Changes made via the REST API to agents or guilds that are also defined in `mcp.yaml` will be overwritten on the next config reload (file save or process restart). Use the REST API for write operations only on auto-registered agents (not defined in YAML) or for ephemeral scripted changes. For durable configuration, edit `mcp.yaml`.

### 9.0 Response conventions

All REST API responses are JSON (`Content-Type: application/json`).

**Error responses** always use:

```json
{ "error": "Human-readable message", "code": "machine_readable_code" }
```

| HTTP status | When used                                                     |
| ----------- | ------------------------------------------------------------- |
| `400`       | Malformed request or invalid parameter                        |
| `404`       | Resource not found                                            |
| `409`       | Conflict (alias taken, reserved slug)                         |
| `415`       | Unsupported Media Type (wrong Content-Type on write endpoint) |
| `422`       | Semantically invalid (e.g. updating immutable `slug`)         |
| `429`       | Rate limit exceeded                                           |
| `500`       | Unexpected server error                                       |
| `503`       | Service temporarily unavailable (DB busy, startup incomplete) |

The `code` field uses snake_case strings. These are stable — callers may rely on them. See §9.0.1 for the complete taxonomy.

**Authentication (v1):** REST API endpoints are unauthenticated in v1. The API port MUST NOT be exposed to untrusted networks. Milestone 7 introduces `MCP_AGGREGATOR_API_KEY` bearer token. Until then, use network-layer controls.

**CSRF protection:** REST API write endpoints (POST, PUT, PATCH, DELETE) MUST require `Content-Type: application/json` and reject `application/x-www-form-urlencoded` or `multipart/form-data` with HTTP 415. This provides CSRF mitigation by ensuring form-based cross-origin submissions cannot trigger state changes.

**Rate limiting:**

- Agent auto-registration (`/mcp/agents/:id` on first connect): 60 new registrations/minute/source IP → 429 if exceeded.
- `POST /servers/:id/test`: 10 concurrent in-flight system-wide, 2/minute/source IP → 429.
- All REST API write endpoints: 120 requests/minute/source IP in unauthenticated mode → 429.

All 429 responses MUST include rate limit headers (see §9.0.3).

**Pagination (v1):** All list endpoints return the full result set with a `meta` envelope containing `total`. The cursor-based pagination contract for v2 is pre-specified in §9.0.2 — implement list endpoints to be forward-compatible with it. The `sessions` table is capped at 1000 rows.

### 9.0.1 Error Code Taxonomy

All machine-readable `code` values returned by the API. Implementors MUST use exactly these strings — do not invent new codes without adding them here.

| Code                             | HTTP status | Meaning                                                                                   |
| -------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `not_found`                      | 404         | The requested resource does not exist                                                     |
| `bad_request`                    | 400         | Malformed JSON body or missing required field                                             |
| `invalid_field`                  | 400         | A field value fails validation (type, length, format)                                     |
| `invalid_agent_id`               | 400         | Agent ID does not match `^[a-z0-9][a-z0-9-]{0,62}$`                                       |
| `invalid_color`                  | 422         | Guild color does not match `^#[0-9a-fA-F]{6}$`                                            |
| `invalid_alias`                  | 422         | Server alias does not match `[a-z][a-z0-9-]*`                                             |
| `alias_conflict`                 | 409         | The alias is already taken by another server                                              |
| `alias_reserved`                 | 409         | The alias is a reserved value (e.g. `mcp`)                                                |
| `slug_immutable`                 | 422         | Attempt to change a guild's `slug` after creation                                         |
| `system_resource`                | 409         | Attempt to delete or mutate a system-managed resource (e.g. `default` guild)              |
| `yaml_managed`                   | 409         | Attempt to delete a resource that is managed by `mcp.yaml`                                |
| `already_member`                 | 409         | Agent is already in the specified guild                                                   |
| `not_member`                     | 404         | Agent is not in the specified guild (on DELETE)                                           |
| `server_already_in_guild`        | 409         | Server is already assigned to the specified guild                                         |
| `server_not_in_guild`            | 404         | Server is not in the specified guild (on DELETE)                                          |
| `direct_server_already_assigned` | 409         | Server is already directly assigned to the agent                                          |
| `direct_server_not_assigned`     | 404         | Server is not directly assigned to the agent (on DELETE)                                  |
| `session_not_found`              | 404         | The specified session ID does not exist                                                   |
| `session_already_closed`         | 200         | Force-close called on an already-closed session (not an error — returns 200)              |
| `transport_incompatible`         | 422         | Field is incompatible with the server's transport type (e.g. `command` on an HTTP server) |
| `upstream_test_failed`           | 200         | Live connection test completed but the upstream returned an error (not an HTTP error)     |
| `upstream_test_timeout`          | 200         | Live connection test timed out (not an HTTP error — see §9.0.4)                           |
| `db_busy`                        | 503         | SQLite write contention exceeded `busy_timeout`; retry after `Retry-After`                |
| `rate_limited`                   | 429         | Rate limit exceeded; retry after `Retry-After`                                            |
| `unsupported_media_type`         | 415         | Write endpoint received non-JSON `Content-Type`                                           |

### 9.0.2 Cursor-Based Pagination Contract

Although v1 list endpoints return the full result set, all list response shapes MUST include a `meta` object so the UI and API clients can be written once and work in both v1 (full set) and v2 (paginated). Implementors MUST NOT omit `meta` from list responses.

**v1 list response envelope:**

```json
{
  "data": [
    /* array of resource objects */
  ],
  "meta": {
    "total": 42,
    "cursor": null,
    "has_more": false
  }
}
```

**v2 cursor-based pagination** (pre-specified here so client code can be written today):

Pagination is opt-in via query parameters. When absent, the full result set is returned (v1 behaviour).

| Query parameter | Type                       | Description                                                        |
| --------------- | -------------------------- | ------------------------------------------------------------------ |
| `limit`         | integer 1–500, default 100 | Maximum number of items to return                                  |
| `cursor`        | opaque string              | Continuation cursor from a previous response's `meta.cursor`       |
| `sort`          | string                     | Field name to sort by (see §9.0.5 for allowed values per resource) |
| `order`         | `asc` \| `desc`            | Sort direction (default `asc`)                                     |

**v2 paginated response envelope:**

```json
{
  "data": [
    /* resource objects */
  ],
  "meta": {
    "total": 1042,
    "limit": 100,
    "cursor": "eyJpZCI6InV1aWQiLCJkaXIiOiJhc2MifQ==",
    "has_more": true
  }
}
```

**Cursor semantics:**

- Cursors are opaque base64-encoded JSON objects. Clients MUST treat them as opaque strings.
- Cursor contents (implementation detail, not part of the API contract): `{ "id": "<last_seen_id>", "field": "<sort_field>", "value": "<last_seen_sort_value>", "dir": "asc"|"desc" }`.
- Cursors encode a keyset position, not an offset. This ensures stable results under concurrent inserts and deletes.
- A cursor returned from one endpoint MUST NOT be used on a different endpoint. Cursor values are bound to the resource type and sort field they were issued for.
- When `has_more` is `false`, `cursor` is `null`. Clients MUST check `has_more` rather than checking whether `cursor` is non-null (both are equivalent but `has_more` is more explicit).
- Cursors expire after 5 minutes. A request with an expired cursor returns 400 with `code: "invalid_cursor"`.

**Forward-compatibility rule for v1 list endpoints:** Implement list handlers to read `limit` and `cursor` from query params and return the `meta` envelope, even if pagination logic is not yet implemented. Return 400 with `code: "pagination_not_supported"` if `cursor` is provided in v1. This allows client code to be written against the v2 shape without breaking v1.

### 9.0.3 Rate Limit Response Headers

All responses from rate-limited endpoints MUST include these headers, regardless of whether the request was allowed or rejected:

| Header                  | Type                     | Description                              |
| ----------------------- | ------------------------ | ---------------------------------------- |
| `X-RateLimit-Limit`     | integer                  | Maximum requests allowed in the window   |
| `X-RateLimit-Remaining` | integer                  | Requests remaining in the current window |
| `X-RateLimit-Reset`     | Unix timestamp (seconds) | When the current window resets           |
| `X-RateLimit-Window`    | integer (seconds)        | Duration of the rate limit window        |

When a request is rejected (HTTP 429), the response MUST also include:

| Header        | Type              | Description                              |
| ------------- | ----------------- | ---------------------------------------- |
| `Retry-After` | integer (seconds) | How many seconds to wait before retrying |

**Example 429 response:**

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1741608060
X-RateLimit-Window: 60
Retry-After: 23

{
  "error": "Rate limit exceeded: 120 requests per minute",
  "code": "rate_limited"
}
```

Rate limit headers MUST be added by Express middleware applied before all REST API route handlers. The middleware uses a sliding window counter keyed by `(source_ip, endpoint_group)`. Endpoint groups map to the three limits defined in §9.0: `registration`, `test`, and `write`.

### 9.0.4 `POST /servers/:id/test` Response Schema

The test-connection endpoint makes a live upstream connection. It always returns HTTP 200 — connection success or failure is communicated in the response body, not the HTTP status code (because the HTTP request itself succeeded).

**Success response:**

```json
{
  "status": "connected",
  "transport_type": "stdio",
  "tool_count": 14,
  "resource_count": 0,
  "prompt_count": 2,
  "tools": [{ "name": "create_issue", "description": "Create a GitHub issue" }],
  "latency_ms": 312,
  "server_info": {
    "name": "github-mcp-server",
    "version": "1.4.0"
  }
}
```

**Failure response (upstream error — still HTTP 200):**

```json
{
  "status": "error",
  "code": "upstream_test_failed",
  "error": "spawn ENOENT: command not found: npx",
  "latency_ms": 45
}
```

**Timeout response (still HTTP 200):**

```json
{
  "status": "timeout",
  "code": "upstream_test_timeout",
  "timeout_ms": 30000
}
```

The `tools` array in success responses is capped at 50 entries for the test endpoint — it is a preview, not a complete enumeration.

### 9.0.5 List Endpoint Filtering and Sorting Conventions

All list endpoints accept the following common query parameters. Endpoint-specific parameters are documented inline.

**Common filtering parameters:**

| Parameter      | Applies to                       | Description                                                                        |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `q`            | `/agents`, `/guilds`, `/servers` | Full-text search on `name`/`id`/`display_name`. Case-insensitive substring match.  |
| `status`       | `/agents`, `/sessions`           | Filter by status. `/agents`: `connected`, `idle`. `/sessions`: `active`, `closed`. |
| `yaml_managed` | `/agents`, `/guilds`, `/servers` | `true`/`false` — filter by YAML management state.                                  |
| `guild`        | `/agents`, `/servers`            | Filter agents/servers by guild slug (e.g. `?guild=qa-engineer`).                   |

**Sort fields by resource:**

| Resource   | Sortable fields                                                          | Default             |
| ---------- | ------------------------------------------------------------------------ | ------------------- |
| `agents`   | `id`, `display_name`, `last_seen_at`, `session_count`, `tool_count`      | `id asc`            |
| `guilds`   | `slug`, `name`, `created_at`                                             | `slug asc`          |
| `servers`  | `alias`, `name`, `created_at`, `last_connected_at`, `consecutive_errors` | `alias asc`         |
| `sessions` | `connected_at`, `duration`, `tool_count`                                 | `connected_at desc` |

Unknown sort fields return 400 with `code: "invalid_sort_field"`. Unknown filter values return an empty `data` array (not an error).

**Example:**

```
GET /api/agents?status=connected&guild=qa-engineer&sort=last_seen_at&order=desc&limit=20
```

### 9.0.6 Idempotency Keys for Write Operations

Write operations that trigger hot-reloads (guild assignments, server enable/disable) are idempotent at the database level (a second identical assignment returns 409 `already_member`). However, for scripted deploy pipelines where the same script may run multiple times, callers can supply an `Idempotency-Key` header to make POST and DELETE requests safe to retry.

**Supported on:** `POST /agents/:id/guilds`, `DELETE /agents/:id/guilds/:guild-id`, `POST /agents/:id/servers`, `DELETE /agents/:id/servers/:server-id`, `POST /guilds/:id/servers`, `DELETE /guilds/:id/servers/:server-id`, `POST /servers`, `POST /guilds`, `POST /agents`.

**Header:** `Idempotency-Key: <client-generated UUID or unique string, max 128 chars>`

**Behaviour:**

- On first request: execute normally, cache the response keyed by `(method, path, Idempotency-Key)` for 24 hours.
- On retry with same key: return the cached response with added header `Idempotency-Replay: true`. The operation is NOT re-executed.
- Cache is stored in-memory (SQLite `idempotency_cache` table for durability across restarts).
- If the original request is still in flight when a retry arrives: return 409 with `code: "idempotency_conflict"` and `Retry-After: 2`.

**Example:**

```http
POST /api/agents/garry/guilds HTTP/1.1
Content-Type: application/json
Idempotency-Key: deploy-2026-03-10-run-42

{ "guild_id": "uuid-of-ceo-guild" }
```

Idempotency keys are optional. Without them, callers must handle 409 `already_member` responses themselves.

### 9.0.7 API Versioning Strategy

**v1 position:** The API is served at `/api` with no version prefix. Breaking changes are avoided by additive evolution: new fields are added to existing response shapes, new optional parameters to existing endpoints, new endpoints for new functionality. Removing fields or changing field types constitutes a breaking change and requires a major version bump.

**Breaking change policy:**

1. A `/api/v2` prefix is introduced when the first breaking change is needed.
2. `/api` (unversioned) continues to serve the v1 contract for a deprecation period of at least 6 months.
3. Deprecated endpoints respond with a `Deprecation: true` header and a `Link` header pointing to the migration guide.
4. After the deprecation period, `/api` is aliased to `/api/v2`.

**Non-breaking changes (safe to ship without version bump):**

- Adding new optional request fields (ignored by v1 clients)
- Adding new response fields (ignored by clients that don't know about them)
- Adding new endpoints
- Adding new `code` values to the error taxonomy (clients should handle unknown codes gracefully)
- Relaxing validation rules (accepting more inputs)

**Breaking changes (require `/api/v2`):**

- Removing or renaming response fields
- Changing a field's type
- Making previously optional fields required
- Changing HTTP status codes for existing error scenarios
- Removing endpoints
- Changing the semantics of existing `code` values

**OpenAPI specification strategy:** The API MUST be documented as an OpenAPI 3.1 specification at `GET /api/openapi.json`. This endpoint is served statically from a generated file committed to the repository — it is NOT generated at request time. The spec MUST be regenerated and committed as part of the CI pipeline whenever API route files change. Use `zod-to-openapi` (or equivalent) to derive the OpenAPI spec from the Zod validation schemas that already gate all request inputs. This ensures the spec stays in sync with the actual validation logic.

The Swagger UI is served at `GET /api/docs` in development (`NODE_ENV !== 'production'`). In production it is disabled by default; set `MCP_AGGREGATOR_ENABLE_SWAGGER=true` to enable it.

### 9.0.8 Server-Sent Events Endpoint (`GET /api/events`)

The web UI requires real-time updates for the session monitor and dashboard. In v1 the UI polls at 5-second intervals. This section pre-specifies the SSE contract so the UI can be upgraded to push-based updates in Milestone 3 without API changes.

**Endpoint:** `GET /api/events`

**Response headers:**

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

The `X-Accel-Buffering: no` header instructs nginx to disable response buffering for this endpoint specifically (overrides the default proxy configuration).

**Event stream format** (standard SSE):

```
id: <event-id>
event: <event-type>
data: <JSON payload>

```

**Event types and payloads:**

| Event type           | Trigger                                               | Payload                                                                                                                                     |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.opened`     | New MCP session established                           | `{ "session_id": "uuid", "agent_id": "garry" \| null, "guild_slugs": [...] \| null, "tool_count": 67, "connected_at": "ISO8601" }`          |
| `session.closed`     | Session ended (clean or force-close)                  | `{ "session_id": "uuid", "agent_id": "garry" \| null, "reason": "client_disconnect" \| "force_close" \| "reload", "duration_ms": 3600000 }` |
| `upstream.error`     | Upstream connection failed (keepalive ping)           | `{ "session_id": "uuid", "alias": "github", "server_id": "uuid", "error": "timeout" }`                                                      |
| `upstream.recovered` | Previously-errored upstream recovered                 | `{ "session_id": "uuid", "alias": "github", "server_id": "uuid" }`                                                                          |
| `config.reloaded`    | YAML file reloaded or REST API write triggered reload | `{ "source": "yaml" \| "api", "affected_agent_count": 3 }`                                                                                  |
| `agent.registered`   | New agent auto-registered on first connect            | `{ "agent_id": "new-bot", "registration_source": "auto" }`                                                                                  |
| `ping`               | Keepalive (every 30 seconds)                          | `{}`                                                                                                                                        |

**Reconnection:** Clients MUST use the `id` field from each event and send `Last-Event-ID` on reconnect. The server MUST replay events from the last seen ID for up to 60 seconds of missed events (buffered in-memory, rolling 60-second window). Events older than the buffer are not replayed; the client receives a `resync` pseudo-event indicating it should perform a full GET to refresh its state.

**v1 fallback:** In v1 (if SSE is not yet implemented), the endpoint returns 501 with `{ "error": "SSE endpoint not yet implemented; use polling", "code": "not_implemented" }`. The UI MUST handle this gracefully and fall back to polling.

**WebSocket upgrade path:** For future bidirectional use (e.g. the session monitor sending force-close commands), the `/api/events` endpoint can be upgraded to WebSocket in v2. The upgrade path is `/api/ws`. Do not implement WebSocket in v1 — the complexity is not warranted when SSE covers all current UI use cases. The reverse proxy configuration in §16.3 already handles SSE (chunked streaming); WebSocket would require adding `proxy_set_header Upgrade $http_upgrade` to the nginx snippet.

### Agents

| Method   | Path                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/agents`                        | List all agents with status, guild memberships, tool counts. Supports `?status=`, `?guild=`, `?q=`, `?sort=`, `?order=` (see §9.0.5). Returns `{ data: [...], meta: { total, cursor, has_more } }`.                                                                                                                                                                                                                                       |
| `POST`   | `/agents`                        | Pre-register an agent (optional; agents also auto-register on connect). Idempotency-Key supported.                                                                                                                                                                                                                                                                                                                                        |
| `GET`    | `/agents/:id`                    | Agent detail: guilds, direct servers, tool count, session history                                                                                                                                                                                                                                                                                                                                                                         |
| `PATCH`  | `/agents/:id`                    | Partial update: `display_name` only. `id` is immutable — returns 422 if included. Only fields present in the body are updated; absent fields are unchanged.                                                                                                                                                                                                                                                                               |
| `DELETE` | `/agents/:id`                    | Remove agent record. Returns 409 if `yaml_managed = true`.                                                                                                                                                                                                                                                                                                                                                                                |
| `GET`    | `/agents/:id/sessions`           | Session history for this agent. Returns `{ data: [...], meta: { total, cursor, has_more } }`.                                                                                                                                                                                                                                                                                                                                             |
| `GET`    | `/agents/:id/tools`              | Aggregated tool list for this agent — see §9.1                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET`    | `/agents/:id/guilds`             | List guilds this agent belongs to. Returns `{ data: [...], meta: { total } }`.                                                                                                                                                                                                                                                                                                                                                            |
| `POST`   | `/agents/:id/guilds`             | Add agent to a guild `{ "guild_id": "uuid" }`. Returns 409 `already_member` if already assigned. Idempotency-Key supported.                                                                                                                                                                                                                                                                                                               |
| `PUT`    | `/agents/:id/guilds`             | **Bulk replace** guild assignments. Body: `{ "guild_ids": ["uuid1", "uuid2"] }`. Atomically removes all current guild assignments and assigns the specified guilds in one transaction. Returns 204 on success. Returns 422 if any `guild_id` is unknown. If the array is empty, all guild assignments are removed. YAML-managed guild assignments are NOT protected from bulk replace — use this endpoint only on auto-registered agents. |
| `DELETE` | `/agents/:id/guilds/:guild-id`   | Remove agent from a guild. Returns 404 `not_member` if not assigned. Idempotency-Key supported.                                                                                                                                                                                                                                                                                                                                           |
| `GET`    | `/agents/:id/servers`            | List direct server assignments. Returns `{ data: [...], meta: { total } }`.                                                                                                                                                                                                                                                                                                                                                               |
| `POST`   | `/agents/:id/servers`            | Add a direct server assignment `{ "server_id": "uuid" }`. Returns 409 `direct_server_already_assigned` if already assigned. Idempotency-Key supported.                                                                                                                                                                                                                                                                                    |
| `DELETE` | `/agents/:id/servers/:server-id` | Remove a direct server assignment. Returns 404 `direct_server_not_assigned` if not assigned. Idempotency-Key supported.                                                                                                                                                                                                                                                                                                                   |

**PATCH vs PUT semantics for agents:** `PATCH /agents/:id` updates only the fields present in the request body — it is a partial update. `PUT /agents/:id/guilds` performs a full replacement of the guild list — it is not a partial update. This distinction is intentional: the guild list is a set membership with replace-all semantics, while the agent record itself has partial-update semantics. Never use `PUT /agents/:id` (not defined — would require sending the complete agent record and risks overwriting fields the caller does not intend to change).

### Guilds

| Method   | Path                             | Description                                                                                                                                                                            |
| -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/guilds`                        | List all guilds with member count and agent count. Supports `?q=`, `?yaml_managed=`, `?sort=`, `?order=` (see §9.0.5). Returns `{ data: [...], meta: { total, cursor, has_more } }`.   |
| `POST`   | `/guilds`                        | Create a guild. Idempotency-Key supported.                                                                                                                                             |
| `GET`    | `/guilds/:id`                    | Guild detail: member servers, assigned agents, tool preview                                                                                                                            |
| `PATCH`  | `/guilds/:id`                    | Partial update: `name`, `description`, `color`. `slug` is immutable after creation — returns 422 if included. Only fields present in the body are updated.                             |
| `DELETE` | `/guilds/:id`                    | Delete guild (unassigns all agents — they get no guild). Returns 409 `system_resource` if `slug = 'default'`. Returns 409 `yaml_managed` if managed by YAML.                           |
| `GET`    | `/guilds/:id/servers`            | List servers in this guild. Returns `{ data: [...], meta: { total } }`.                                                                                                                |
| `POST`   | `/guilds/:id/servers`            | Add server to guild `{ "server_id": "uuid" }`. Returns 409 `server_already_in_guild` if already assigned. Idempotency-Key supported.                                                   |
| `PUT`    | `/guilds/:id/servers`            | **Bulk replace** server assignments. Body: `{ "server_ids": ["uuid1", "uuid2"] }`. Atomically replaces all server assignments. Returns 204. Returns 422 if any `server_id` is unknown. |
| `DELETE` | `/guilds/:id/servers/:server-id` | Remove server from guild. Returns 404 `server_not_in_guild` if not assigned. Idempotency-Key supported.                                                                                |
| `GET`    | `/guilds/:id/agents`             | List agents in this guild. Returns `{ data: [...], meta: { total } }`.                                                                                                                 |
| `GET`    | `/guilds/:id/tools`              | Preview: all tools this guild would expose (from `server_tool_cache` — see §9.2)                                                                                                       |

### Upstream Servers

| Method   | Path                        | Description                                                                                                                                                                                                                                                                                                                   |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/servers`                  | List all upstream servers with guild memberships. Supports `?q=`, `?guild=`, `?yaml_managed=`, `?status=connected\|error`, `?sort=`, `?order=` (see §9.0.5). Returns `{ data: [...], meta: { total, cursor, has_more } }`.                                                                                                    |
| `POST`   | `/servers`                  | Add a new upstream server. Returns 409 `alias_conflict` if `alias` is already taken, 409 `alias_reserved` if `alias = 'mcp'`. Idempotency-Key supported.                                                                                                                                                                      |
| `GET`    | `/servers/:id`              | Server detail — see §9.3.1 for response schema                                                                                                                                                                                                                                                                                |
| `PATCH`  | `/servers/:id`              | Partial update of server config: `name`, `alias`, `enabled`, `timeout_ms`. Transport config (`command`, `args`, `url`) is read-only via API — change in YAML only (returns 422 `transport_config_immutable` if included). Returns 409 `alias_conflict` if new `alias` conflicts. Only fields present in the body are updated. |
| `DELETE` | `/servers/:id`              | Remove server (removes from all guilds, removes direct assignments). Returns 409 `yaml_managed` if managed by YAML.                                                                                                                                                                                                           |
| `POST`   | `/servers/:id/enable`       | Enable server globally. Idempotent — returns 200 even if already enabled.                                                                                                                                                                                                                                                     |
| `POST`   | `/servers/:id/disable`      | Disable server globally. Idempotent — returns 200 even if already disabled.                                                                                                                                                                                                                                                   |
| `POST`   | `/servers/:id/test`         | Test connection — see §9.0.4 for full response schema. Makes a live upstream connection using the server's configured `timeout_ms`; does not persist any state.                                                                                                                                                               |
| `GET`    | `/servers/:id/env`          | List env var **keys only** — values are never returned. Returns `{ "keys": ["KEY1", "KEY2"] }`.                                                                                                                                                                                                                               |
| `PUT`    | `/servers/:id/env`          | Full replacement of all env vars. Body: `{ "KEY1": "value1", "KEY2": "value2" }`. Values accepted on write, never returned. Responds with `{ "keys": ["KEY1", "KEY2"] }`. The existing env vars are atomically deleted and replaced.                                                                                          |
| `DELETE` | `/servers/:id/env/:key`     | Remove a single env var. Returns 404 if key does not exist.                                                                                                                                                                                                                                                                   |
| `GET`    | `/servers/:id/headers`      | List header **keys only** — values are never returned. Returns `{ "keys": ["Authorization"] }`.                                                                                                                                                                                                                               |
| `PUT`    | `/servers/:id/headers`      | Full replacement of all headers. Body: `{ "Authorization": "Bearer token" }`. Values accepted on write, never returned. Responds with `{ "keys": ["Authorization"] }`.                                                                                                                                                        |
| `DELETE` | `/servers/:id/headers/:key` | Remove a single header. Returns 404 if key does not exist.                                                                                                                                                                                                                                                                    |

**PUT vs PATCH for servers:** `PUT /servers/:id/env` and `PUT /servers/:id/headers` use PUT because they perform full replacement of the credential set — sending a partial set would silently drop existing credentials. `PATCH /servers/:id` uses PATCH because the server record has many independent fields and partial updates are expected (e.g. changing only `timeout_ms`).

### Sessions

| Method   | Path            | Description                                                                                                                                                                                           |
| -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/sessions`     | List sessions. Defaults to `?status=active`. Supports `?status=active\|closed\|all`, `?agent=:id`, `?sort=connected_at`, `?order=desc`. Returns `{ data: [...], meta: { total, cursor, has_more } }`. |
| `GET`    | `/sessions/:id` | Single session detail including full `upstream_statuses` and `client_info`.                                                                                                                           |
| `DELETE` | `/sessions/:id` | Force-close session — see §9.4                                                                                                                                                                        |

### System

| Method | Path            | Description                                                                                              |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`       | Liveness and readiness probe. Available on the primary MCP port. See §9.5.1 for response schema.         |
| `GET`  | `/status`       | Full operational status: agents, guilds, servers, sessions, tool counts. See §9.5.2 for response schema. |
| `GET`  | `/events`       | Server-Sent Events stream for real-time UI updates — see §9.0.8                                          |
| `GET`  | `/openapi.json` | OpenAPI 3.1 specification (static, generated from Zod schemas) — see §9.0.7                              |
| `GET`  | `/docs`         | Swagger UI (development only; disabled in production unless `MCP_AGGREGATOR_ENABLE_SWAGGER=true`)        |

---

### 9.1 `GET /agents/:id/tools` — Static view

This endpoint returns a **static** tool list built from the database: it resolves the agent's current guilds and direct server assignments, applies tool namespacing rules, and returns the expected tool names from `server_tool_cache`. It does **not** make live upstream connections.

Use cases: UI tool browser, auditing tool access, pre-flight checks.

The response reflects what will be served on the next session start, not necessarily what an already-connected session is serving (which may differ if a hot-reload is in flight). Servers with no cache entries (never successfully connected) appear in `uncached_servers`.

**`source` field schema:**

| Field       | Type                    | Notes                                                                                                                                          |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `alias`     | string                  | Server alias                                                                                                                                   |
| `server_id` | string (UUID)           | Server ID                                                                                                                                      |
| `via`       | `"guild"` \| `"direct"` | How this server is attached to the agent                                                                                                       |
| `guild`     | string \| undefined     | Guild slug — present only when `via = "guild"`. If the same server appears in multiple guilds, the guild with the earliest `added_at` is used. |

**Response:**

```json
{
  "tools": [
    {
      "name": "board__approve_budget",
      "original_name": "approve_budget",
      "description": "Approve a budget request",
      "source": { "alias": "board", "server_id": "uuid", "via": "guild", "guild": "ceo" }
    },
    {
      "name": "github__create_pr",
      "original_name": "create_pr",
      "description": "Create a pull request",
      "source": { "alias": "github", "server_id": "uuid", "via": "guild", "guild": "developer" }
    },
    {
      "name": "garry-crm__internal_crm",
      "original_name": "internal_crm",
      "description": "Look up a contact in the CRM",
      "source": { "alias": "garry-crm", "server_id": "uuid", "via": "direct" }
    }
  ],
  "total": 3,
  "guilds": ["ceo", "developer"],
  "direct_servers": ["garry-crm"],
  "uncached_servers": [],
  "note": "Static view — reflects current DB config and cached tool names, not live upstream state."
}
```

### 9.2 `GET /guilds/:id/tools` — Tool preview

Returns a **static** tool list for a guild, built from `server_tool_cache`. Does not make live upstream connections.

The response reflects what will be served on the next session start for any client connecting via this guild's endpoint. Servers with no cache entries (never successfully connected) appear in `uncached_servers`.

**Response:**

```json
{
  "tools": [
    {
      "name": "browser__navigate",
      "original_name": "navigate",
      "description": "Navigate to a URL",
      "source": { "alias": "browser", "server_id": "uuid" }
    },
    {
      "name": "github__create_issue",
      "original_name": "create_issue",
      "description": "Create a GitHub issue",
      "source": { "alias": "github", "server_id": "uuid" }
    }
  ],
  "total": 2,
  "servers": ["browser", "github"],
  "uncached_servers": [],
  "note": "Static view — reflects current DB config and cached tool names, not live upstream state."
}
```

The `source` object omits the `via`/`guild` fields present in `/agents/:id/tools` — tools are attributed to servers only, since the guild is the context of the request.

---

### 9.3 `GET /servers/:id/env` and `GET /servers/:id/headers` — Keys only

Env var and header values are **write-only**. The `GET` endpoints return keys only:

```json
{
  "keys": ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_APP_ID"]
}
```

Values are never present in any API response. `PUT` accepts `{ "key": "value", ... }` on write, stores them, and responds with the same keys-only shape. This applies equally to headers. The rule holds everywhere: REST API responses, web UI, logs, and `mcp__describe` tool output.

### 9.3.1 `GET /servers/:id` — Response Schema

```json
{
  "id": "uuid",
  "name": "GitHub Tools",
  "alias": "github",
  "transport_type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "url": null,
  "enabled": true,
  "timeout_ms": 30000,
  "yaml_managed": true,
  "env_keys": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  "header_keys": [],
  "cached_tool_count": 14,
  "last_connected_at": "2026-03-10T11:45:00Z",
  "last_error_at": null,
  "last_error_message": null,
  "consecutive_errors": 0,
  "guilds": [
    { "id": "uuid", "slug": "developer", "name": "Developer", "color": "#3b82f6" },
    { "id": "uuid", "slug": "qa-engineer", "name": "QA Engineer", "color": "#10b981" }
  ],
  "active_session_count": 2,
  "created_at": "2026-03-01T09:00:00Z",
  "updated_at": "2026-03-10T09:00:00Z"
}
```

Note: `env_keys` and `header_keys` are the key names only, never values. `command` and `args` are present only for `stdio` transport; `url` is present only for `streamablehttp` and `sse` transports. Transport-irrelevant fields are `null`.

`active_session_count` is the count of sessions currently in `ACTIVE` or `RELOADING` state that have this server connected. It is derived from the in-memory session registry, not from the DB, so it reflects real-time state.

### 9.4 `DELETE /sessions/:id` — Force-close semantics

**Active session definition:** A session is considered "active" when the aggregator holds an in-memory handle for it (the authoritative source of truth). `GET /sessions` reflects this by returning sessions where `disconnected_at IS NULL` in SQLite **and** an in-memory handle exists. If the process crashed without writing `disconnected_at`, those rows remain `NULL` in SQLite but have no in-memory handle on the next startup. On startup, the server writes `disconnected_at = NOW()` to all rows with `disconnected_at IS NULL` as a cleanup step, converging SQLite to match the fresh in-memory state. Calling `DELETE /sessions/:id` on a session whose in-memory handle is absent (stale row from a crash) returns `200` with `{ "status": "already_closed" }` and writes `disconnected_at` if not already set.

The proxy force-closes an active session by:

1. Sending a best-effort MCP notification to the client over the active HTTP response stream (if still open):

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/cancelled",
  "params": {
    "requestId": null,
    "reason": "Session closed by operator"
  }
}
```

2. Closing the HTTP response stream
3. Disconnecting all upstream connections for that session
4. Writing `disconnected_at` to the `sessions` row

`notifications/cancelled` is the closest standard MCP notification for signalling session termination. `requestId: null` indicates this is a session-level cancellation rather than a specific request cancellation. Clients that handle `notifications/cancelled` will surface the reason; clients that ignore unknown notifications will simply see the stream close. The MCP protocol does not define a server-initiated close message; step 1 is a best-effort notification on a response stream that may already be closed on the client side. The session is considered closed once step 4 completes regardless of whether the client received step 1.

---

### 9.4.1 `GET /health` — Response Schema

The `/health` endpoint is documented in §16.2 for probe configuration. This section provides the normative response schema for API callers.

**HTTP 200 — healthy:**

```json
{
  "status": "ok",
  "version": "1.2.3",
  "uptime_seconds": 3600,
  "active_sessions": 3,
  "db": "ok",
  "migrations_pending": 0
}
```

**HTTP 503 — degraded:**

```json
{
  "status": "degraded",
  "version": "1.2.3",
  "uptime_seconds": 45,
  "active_sessions": 0,
  "db": "error",
  "db_error": "SQLITE_BUSY: database is locked",
  "migrations_pending": 2
}
```

`db_error` is present only when `db != "ok"`. It contains a safe error message — never a SQL query or internal stack trace. The `migrations_pending` field is informational; in normal operation it is always `0` because the startup sequence runs migrations before binding the port.

### 9.4.2 `GET /status` — Response Schema

The `/status` endpoint provides a full operational snapshot for the web UI dashboard and monitoring integrations. It is more expensive than `/health` and MUST NOT be used as a probe target.

**HTTP 200:**

```json
{
  "version": "1.2.3",
  "uptime_seconds": 7200,
  "db": "ok",
  "agents": {
    "total": 8,
    "connected": 3,
    "idle": 5
  },
  "guilds": {
    "total": 4
  },
  "servers": {
    "total": 12,
    "enabled": 11,
    "disabled": 1,
    "with_errors": 1,
    "error_details": [
      {
        "alias": "slack",
        "server_id": "uuid",
        "consecutive_errors": 3,
        "last_error_at": "2026-03-10T11:55:00Z",
        "last_error_message": "Connection timeout after 30000ms"
      }
    ]
  },
  "sessions": {
    "active": 3,
    "last_24h": 47
  },
  "tools": {
    "total_cached": 412
  },
  "config": {
    "yaml_path": "/home/user/.mcp-aggregator/mcp.yaml",
    "last_reloaded_at": "2026-03-10T09:00:00Z",
    "reload_count": 5
  }
}
```

`error_details` lists servers where `consecutive_errors > 0`. `last_24h` in sessions is a COUNT query against `sessions` where `connected_at >= NOW() - 24h`. `tools.total_cached` is the sum of `cached_tool_count` across all enabled servers.

### 9.5 Startup sequence

The following steps execute **before** the HTTP listener binds to the port, so no incoming request can observe a partially-initialised state:

1. Open SQLite connection with required pragmas (`PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, etc. — see §5.4)
2. Run pending Drizzle migrations. If `MCP_AGGREGATOR_MIGRATION_PROMPT=never`, auto-apply without prompt. On failure, exit with non-zero code — do not start against a stale schema.
3. Seed the `default` guild (`INSERT OR IGNORE INTO guilds … is_system = 1`)
4. **Crash recovery** (in a single transaction):
   a. Set `disconnected_at = NOW()` on all sessions where `disconnected_at IS NULL`
   b. Set `status = 'error'`, `error_msg = 'Process terminated'` on all `session_upstreams` where `disconnected_at IS NULL`
   c. Log at INFO: "Crash recovery: closed N stale sessions."
5. Load and parse `mcp.yaml` (env var interpolation applied, symlink protection checked)
6. Apply YAML-to-SQLite sync (upsert servers, guilds, agents with `yaml_managed = 1`)
7. Start chokidar file watcher
8. Bind HTTP listener

### 9.6 Audit log

The proxy MUST maintain a structured `audit_log` table in SQLite:

| Column        | Type         | Notes                                                                                                  |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| `id`          | TEXT UUID    | PK                                                                                                     |
| `event_type`  | TEXT         | e.g. `server.created`, `server.env.updated`, `guild.agent.added`, `session.force_closed`               |
| `actor`       | TEXT         | Source IP or `"operator"` in unauthenticated mode; API key ID in authenticated mode                    |
| `target_id`   | TEXT         | ID of the affected resource                                                                            |
| `target_type` | TEXT         | `agent` \| `guild` \| `server` \| `session`                                                            |
| `payload`     | TEXT (JSON)  | Change summary. MUST NOT include credential values — for env/header updates, record only keys changed. |
| `created_at`  | TEXT ISO8601 |                                                                                                        |

All write operations (POST, PUT, PATCH, DELETE) on the REST API MUST generate an audit log entry. The `sessions` table alone is insufficient as it does not record configuration changes.

**Log sanitization:** HTTP request/response logging middleware MUST redact request bodies for `PUT /servers/:id/env` and `PUT /servers/:id/headers`. The redacted form records only key names: `{ "keys_updated": ["GITHUB_TOKEN"] }`.

### Key Request Schemas

**POST /guilds**

```json
{
  "name": "QA Engineer",
  "slug": "qa-engineer",
  "description": "Tools for QA testing workflows",
  "color": "#10b981"
}
```

**POST /guilds/:id/servers**

```json
{ "server_id": "uuid" }
```

**PATCH /agents/:id**

```json
{
  "display_name": "Garry (CEO agent)"
}
```

**POST /agents/:id/guilds**

```json
{ "guild_id": "uuid-of-ceo-guild" }
```

**GET /agents response** — uses `{ data, meta }` envelope (see §9.0.2):

```json
{
  "data": [
    {
      "id": "garry",
      "display_name": "Garry (CEO agent)",
      "guilds": [
        { "id": "uuid", "name": "CEO", "slug": "ceo", "color": "#8b5cf6" },
        { "id": "uuid", "name": "Developer", "slug": "developer", "color": "#3b82f6" }
      ],
      "direct_server_count": 1,
      "tool_count": 67,
      "status": "connected",
      "active_sessions": 1,
      "last_seen_at": "2026-03-10T12:00:00Z",
      "yaml_managed": false,
      "registration_source": "api",
      "created_at": "2026-03-01T09:00:00Z"
    },
    {
      "id": "claude-qa-1",
      "display_name": "Claude QA Bot 1",
      "guilds": [
        { "id": "uuid", "name": "QA Engineer", "slug": "qa-engineer", "color": "#10b981" }
      ],
      "direct_server_count": 0,
      "tool_count": 34,
      "status": "idle",
      "active_sessions": 0,
      "last_seen_at": "2026-03-10T10:00:00Z",
      "yaml_managed": true,
      "registration_source": "yaml",
      "created_at": "2026-02-15T08:00:00Z"
    }
  ],
  "meta": {
    "total": 2,
    "cursor": null,
    "has_more": false
  }
}
```

**POST /agents request** (pre-registration):

```json
{
  "id": "new-agent",
  "display_name": "New Agent",
  "guild_ids": ["uuid-of-ceo-guild"],
  "server_ids": ["uuid-of-garry-crm"]
}
```

`guild_ids` and `server_ids` are optional arrays. Including them assigns guilds and direct servers atomically with registration. Returns 409 if `id` is already taken.

**PUT /agents/:id/guilds request** (bulk guild replace):

```json
{ "guild_ids": ["uuid-of-ceo-guild", "uuid-of-developer-guild"] }
```

Returns 204 No Content on success. An empty array removes all guild assignments.

**POST /servers**

```json
{
  "name": "GitHub Tools",
  "alias": "github",
  "transport_type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
  },
  "timeout_ms": 30000,
  "enabled": true
}
```

**PATCH /servers/:id request** (partial update — only fields present are updated):

```json
{
  "timeout_ms": 60000
}
```

Returns the full updated server object (same shape as `GET /servers/:id`). Transport config fields (`command`, `args`, `url`) return 422 `transport_config_immutable` if included.

**PATCH /agents/:id request** (partial update):

```json
{
  "display_name": "Garry (Updated Title)"
}
```

Returns the full updated agent object.

---

## 10. Web UI Specification

### Technology

React 19 + Vite 6, Tailwind CSS 4, Radix UI, TanStack Query (consistent with Paperclip monorepo). Auto-refetch every 5s for live status. Read-only — configuration is done in `mcp.yaml`. The only write actions exposed are operational: force-close a session, globally disable/enable an upstream server.

### Dashboard (`/`)

The primary view. Should answer at a glance: _who is connected, do they have the right tools, is anything broken?_

```
┌──────────────────────────────────────────────────────────────────┐
│  MCP Aggregator                                    ● Running      │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ 8 Agents │  │ 4 Guilds │  │ 12 Upstreams │  │ 3 Sessions  │  │
│  │ 3 active │  │ 34 tools │  │ 10 connected │  │ active      │  │
│  └──────────┘  └──────────┘  └──────────────┘  └─────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│  Connected Agents                                    [see all →]  │
│  ● garry        [ceo] [developer] +1 direct  67 tools  0s ago    │
│  ● claude-qa-1  [qa-engineer]                34 tools  2m ago    │
│  ● claude-ops-1 [devops]                     51 tools  1m ago    │
├──────────────────────────────────────────────────────────────────┤
│  Upstream Health                                                  │
│  ● github     connected  ·  used by 3 agents                     │
│  ● browser    connected  ·  used by 2 agents                     │
│  ✕ slack      error: timeout  ·  used by 2 agents  [details →]   │
├──────────────────────────────────────────────────────────────────┤
│  Recent Sessions                                    [see all →]  │
│  garry         started 0s ago   67 tools  active                 │
│  new-agent-1   started 5s ago    0 tools  ⚠ no guilds assigned   │
│  claire        ended 1h ago     45 tools  12 min                 │
└──────────────────────────────────────────────────────────────────┘
```

Agents with no guilds show a warning with the YAML snippet needed to fix it:

```
⚠ new-agent-1 has no guilds. Add to mcp.yaml:
  agents:
    - id: new-agent-1
      guilds: [qa-engineer]
```

### Agent List (`/agents`)

Table: agent ID, guilds (colored badge pills), tool count, status indicator (● connected / ○ idle), last seen. Clicking a row opens the agent detail.

### Agent Detail (`/agents/:id`)

```
┌──────────────────────────────────────────────────────────────────┐
│  garry                                          ● Connected       │
│  67 tools  ·  guilds: ceo, developer  ·  +1 direct  ·  12 sess  │
├──────────────────────────────────────────────────────────────────┤
│  Guilds       [ceo]  [developer]                                  │
│  Direct MCPs  ● garry-crm                                         │
├──────────────────────────────────────────────────────────────────┤
│  Tools (67)                          [search ___]  [filter ▼]    │
│  board__approve_budget     board       via ceo guild              │
│  board__view_reports       board       via ceo guild              │
│  github__create_pr         github      via developer guild        │
│  ide__run_tests            ide         via developer guild        │
│  garry-crm__lookup_contact  garry-crm   direct                   │
├──────────────────────────────────────────────────────────────────┤
│  Active session                                                   │
│  started 2026-03-10 12:00  ·  upstreams: board ● github ● ide ●  │
├──────────────────────────────────────────────────────────────────┤
│  Session History                                                  │
│  2026-03-10 12:00  67 tools  ceo+developer+direct  active        │
│  2026-03-09 09:00  45 tools  ceo                   40min  done   │
│  2026-03-08 14:30  45 tools  ceo                   22min  done   │
├──────────────────────────────────────────────────────────────────┤
│  MCP Connection URL                                               │
│  http://localhost:4000/mcp/agents/garry              [Copy]       │
└──────────────────────────────────────────────────────────────────┘
```

**Key observations available:**

- Full namespaced tool list with source attribution (guild or direct) — answers "does this agent have the tool I expect?"
- Upstream connection status per active session — answers "is everything connected?"
- Session history with tool count delta — "did the tool count change between sessions?"
- Tool filter: by guild, by server, or "direct only"

### Guild List (`/guilds`)

Cards, one per guild with color accent:

```
┌──────────────────────────┐  ┌──────────────────────────┐
│  ■ QA Engineer           │  │  ■ DevOps                 │
│  3 servers · 4 agents    │  │  5 servers · 2 agents     │
│  34 tools exposed        │  │  51 tools exposed         │
│  [view →]                │  │  [view →]                 │
└──────────────────────────┘  └──────────────────────────┘
```

### Guild Detail (`/guilds/:id`)

Tabs:

- **Servers** — list of member upstream servers with connection status across active sessions.
- **Agents** — list of agents in this guild with connection status and tool count.
- **Tools** — full tool preview for this guild (from `server_tool_cache`). Searchable. Shows `⚠ no cache` badge for servers not yet connected.

### Server Detail (`/servers/:id`)

```
┌──────────────────────────────────────────────────────────────────┐
│  github                              alias: github   ● enabled    │
│  stdio · npx -y @modelcontextprotocol/server-github               │
├──────────────────────────────────────────────────────────────────┤
│  Used in guilds   [developer] [qa-engineer]                       │
│  Used by agents   garry (● connected)  claude-qa-1 (○ idle)      │
├──────────────────────────────────────────────────────────────────┤
│  Active connections (2 sessions)                                  │
│  garry / session abc123      ● connected   started 12:00         │
│  claude-qa-1 / session def456  ● connected  started 11:45        │
├──────────────────────────────────────────────────────────────────┤
│  Recent errors                                                    │
│  none                                                             │
├──────────────────────────────────────────────────────────────────┤
│                                          [Disable server]         │
└──────────────────────────────────────────────────────────────────┘
```

The disable/enable toggle is the only write action on this page.

### Session Monitor (`/sessions`)

Table of active and recent sessions. Columns: agent ID (or guild slugs for untracked), connected at, duration, tool count, upstream statuses (colored dots — green/red/grey per upstream), actions (force-close if active). Clicking a row shows the full `upstream_statuses` JSON and `client_info`.

### MCP URL Builder

Available on the Agent detail page and as a standalone panel on the dashboard:

```
┌────────────────────────────────────────────────────────────────┐
│  MCP Connection URLs                                            │
│                                                                 │
│  Named agent (tracked, unauthenticated):                        │
│  http://localhost:4000/mcp/agents/garry           [Copy]        │
│                                                                 │
│  Untracked multi-guild:                                         │
│  Guilds: [qa-engineer] [developer] [+ add]                      │
│  http://localhost:4000/mcp/guilds/qa-engineer,developer [Copy]  │
└────────────────────────────────────────────────────────────────┘
```

---

## 11. Agent Configuration

### Option A — Named agent (tracked, guilds managed in UI)

Best when you want to track individual agents and change their tools without touching their config.

1. Choose an agent ID (e.g. `garry`, `claude-qa-1`)
2. Add to agent's MCP config — **this URL never changes**:

**Claude Code (`.claude/mcp.json`):**

```json
{
  "mcpServers": {
    "proxy": {
      "type": "http",
      "url": "http://localhost:4000/mcp/agents/garry"
    }
  }
}
```

**Claude Desktop:**

```json
{
  "mcpServers": {
    "proxy": {
      "command": "mcp-aggregator-stdio",
      "args": ["--agent", "garry", "--upstream", "http://localhost:4000"]
    }
  }
}
```

3. On first connection: auto-registers with no guilds (0 tools, hint message)
4. Open web UI → assign guilds → agent immediately gets those tools
5. Add more guilds, remove guilds, add direct servers — all from UI, no config change

### Option B — Untracked multi-guild (no agent record, guilds fixed in URL)

Best for ephemeral agents or when you want the guild set encoded in the URL.

```json
{
  "mcpServers": {
    "tools": {
      "type": "http",
      "url": "http://localhost:4000/mcp/guilds/qa-engineer,developer"
    }
  }
}
```

- Tools are the union of all listed guilds, resolved at connect time
- If you add a new MCP server to the `qa-engineer` guild in the UI, the next connection to this URL will include it
- You can list any number of guilds, comma-separated: `qa-engineer,developer,ceo`
- To change the guild set you **do** need to update this URL

### Two CEOs example

Both `garry` and `claire` are CEOs. They both get CEO tools. Garry also has a personal CRM integration.

**garry's config:**

```json
{ "url": "http://localhost:4000/mcp/agents/garry" }
```

In UI: garry → guilds: [ceo] + direct: [garry-crm]

**claire's config:**

```json
{ "url": "http://localhost:4000/mcp/agents/claire" }
```

In UI: claire → guilds: [ceo]

Both get all `ceo` guild tools. Garry additionally gets `garry-crm__*` tools. Neither config ever needs to change.

### 11.1 stdio wrapper — `mcp-aggregator-stdio`

`mcp-aggregator-stdio` is a thin process that accepts MCP requests on stdin/stdout and forwards them over HTTP to the aggregator running on `--upstream`. It exists solely for clients that only support the stdio transport (e.g. Claude Desktop).

**Flags:**

| Flag         | Required | Default | Description                                                                |
| ------------ | -------- | ------- | -------------------------------------------------------------------------- |
| `--upstream` | yes      | —       | Base URL of the running aggregator, e.g. `http://localhost:4000`           |
| `--agent`    | no       | —       | Agent ID. Constructs `/mcp/agents/{id}` when set.                          |
| `--guild`    | no       | —       | Comma-separated guild slugs. Constructs `/mcp/guilds/{slug,...}` when set. |
| `--timeout`  | no       | `30000` | Connection timeout to upstream, in ms.                                     |

Exactly one of `--agent` or `--guild` must be provided (mutual exclusion enforced at startup; exits 1 with a clear error message if neither or both are supplied).

**Behaviour on upstream unavailability:** If the HTTP aggregator cannot be reached at startup, the stdio wrapper writes a JSON-RPC error to stdout and exits with code 1, so the client sees a meaningful failure rather than a silent hang. There is no automatic reconnect — the client must restart the stdio process.

**Claude Desktop example:**

```json
{
  "mcpServers": {
    "proxy": {
      "command": "mcp-aggregator-stdio",
      "args": ["--agent", "garry", "--upstream", "http://localhost:4000"]
    }
  }
}
```

### 11.2 CLI reference — `mcp-aggregator`

**`mcp-aggregator start`** — Start the aggregator server.

| Flag                 | Env var                     | Default                   | Description                                                                 |
| -------------------- | --------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `--port <n>`         | `MCP_AGGREGATOR_PORT`       | `4000`                    | Primary HTTP port                                                           |
| `--api-port <n>`     | `MCP_AGGREGATOR_API_PORT`   | unset                     | Optional second port for UI+API                                             |
| `--public-url <url>` | `MCP_AGGREGATOR_PUBLIC_URL` | `http://localhost:{port}` | Advertised base URL                                                         |
| `--home <path>`      | `MCP_AGGREGATOR_HOME`       | `~/.mcp-aggregator`       | Config and DB directory                                                     |
| `--bind <addr>`      | —                           | `127.0.0.1`               | Bind address. Use `0.0.0.0` for external access (requires explicit opt-in). |

Exit codes: `0` = clean shutdown, `1` = startup failure (logged to stderr).

**`mcp-aggregator validate`** — Validates `mcp.yaml` without starting the server. Useful in CI pipelines to catch config errors before deploy.

**`mcp-aggregator migrate`** — Applies pending SQLite migrations. Runs automatically at server start; this subcommand allows running it in isolation (e.g. in a container init script).

---

## 12. MCP Protocol Details

### 12.1 Unassigned agent initialize response

When an agent connects with no guild:

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": {
    "tools": { "listChanged": true },
    "resources": { "listChanged": true },
    "prompts": { "listChanged": true }
  },
  "serverInfo": {
    "name": "mcp-aggregator",
    "version": "1.0.0"
  },
  "instructions": "This agent (claude-qa-1) has no guild assigned. Assign a guild in the MCP Aggregator UI at {MCP_AGGREGATOR_PUBLIC_URL}/agents/claude-qa-1 to enable tools."
}
```

The proxy always declares `tools`, `resources`, and `prompts` with `listChanged: true` regardless of whether any upstreams are currently connected, because guild assignments can change at any time via hot-reload. Declaring these capabilities upfront ensures the client will honour subsequent `notifications/*/list_changed` notifications.

**Protocol version negotiation:** The proxy MUST echo back the `protocolVersion` the client sent in its `initialize` request if the proxy supports that version. The proxy declares support for `["2024-11-05", "2025-03-26", "2025-06-18"]`. If the client sends an unrecognised version, the proxy responds with its highest supported version. If the client sends a recognised but older version, the proxy MUST respond with that exact version. The examples in this section use `"2025-06-18"` for illustration; the actual value in responses is always determined by negotiation.

For untracked connections to `/mcp` (the `default` guild) that have no servers configured, the instructions omit the agent ID:

```json
{
  "instructions": "The default guild has no servers configured. Add servers to the 'default' guild in mcp.yaml or the MCP Aggregator UI at {MCP_AGGREGATOR_PUBLIC_URL}/guilds/default."
}
```

`tools/list` returns an empty array in both cases. The `instructions` field is surfaced by supporting clients.

### 12.2 Proxy self-description tools

The proxy injects a small set of **meta-tools** into every agent's tool list. These let the LLM introspect its own MCP configuration without needing a separate side-channel. Tools are prefixed `mcp__` to avoid collisions with upstream aliases (the `mcp` alias is reserved — see §12.5).

| Tool name              | Description                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__describe`        | Returns a summary of this agent's current configuration: which guilds it belongs to, which upstream servers are connected, how many tools are available, and the live connection status of each upstream. Intended answer to "am I configured correctly?" |
| `mcp__tools_by_server` | Lists all available tools grouped by upstream server alias and the guild they come from. Useful for "do I have any git tools?" or "which server handles deployment?"                                                                                      |
| `mcp__status`          | Returns the health of each upstream connection for the current session: `connected`, `error` (with last error message), or `disconnected`.                                                                                                                |

**`mcp__describe` response shape:**

```json
{
  "agent_id": "garry",
  "guilds": ["ceo", "developer"],
  "direct_servers": ["garry-crm"],
  "tool_count": 67,
  "upstreams": [
    { "alias": "board", "status": "connected", "tool_count": 12, "via": "guild", "guild": "ceo" },
    {
      "alias": "github",
      "status": "connected",
      "tool_count": 28,
      "via": "guild",
      "guild": "developer"
    },
    { "alias": "garry-crm", "status": "connected", "tool_count": 5, "via": "direct" }
  ],
  "ui_url": "{MCP_AGGREGATOR_PUBLIC_URL}/agents/garry"
}
```

**`mcp__tools_by_server` response shape:**

```json
{
  "servers": [
    {
      "alias": "github",
      "via": "guild",
      "guild": "developer",
      "tools": ["github__create_pr", "github__list_issues", "github__push"]
    },
    {
      "alias": "garry-crm",
      "via": "direct",
      "tools": ["garry-crm__lookup_contact"]
    }
  ]
}
```

These tools are always present and do not require upstream connections — they reflect live proxy state. For untracked guild connections (`/mcp/guilds/...`), `agent_id` is `null` and `guilds` lists the slugs from the URL.

**Response format:** All meta-tool responses conform to the MCP `tools/call` result schema. The JSON shapes above are serialised and returned as:

```json
{
  "content": [{ "type": "text", "text": "{ ... serialised JSON ... }" }],
  "isError": false
}
```

On error: `isError: true` with a descriptive text content item.

**Secret safety:** None of the meta-tools expose env var values or header values. `mcp__describe` includes upstream connection config (alias, transport type, command/URL) but never env keys or header keys — those are not useful to an LLM and could leak credential names.

### 12.3 Capability merging

Proxy's declared capabilities are the union of all connected upstream capabilities:

- `tools: { listChanged: true }` — always declared (proxy always has meta-tools; listChanged reflects that hot-reload can change the set).
- `resources: { listChanged: true }` — declared if any upstream advertises `resources`. The `subscribe` sub-key is **never** forwarded (resource subscriptions are a non-goal, §4); any upstream `resources.subscribe` is silently stripped. Clients that send `resources/subscribe` receive a `-32601 Method not found` error.
- `prompts: { listChanged: true }` — declared if any upstream advertises `prompts`.
- `completions: {}` — declared if any upstream advertises `completions`. The proxy forwards `completion/complete` requests to the upstream that owns the referenced resource or prompt (identified by its namespaced URI/name prefix). For multiple completions-capable upstreams, forwarded to the upstream owning the referenced resource/prompt by its namespaced prefix.
- `logging: {}` — **not** forwarded. The proxy does not proxy `logging/setLevel` or `notifications/message` from upstreams to the downstream client in v1.

**Tool count warning threshold:** When the merged tool count for a session (including meta-tools) exceeds `MCP_AGGREGATOR_TOOL_WARN_THRESHOLD` (default: `128`), the proxy:

1. Logs a `WARN` message: `"Session {session_id} for agent {agent_id} has {N} tools. Many LLM clients truncate tool lists above 128. Consider splitting this agent across multiple guilds or reducing guild membership."`
2. Includes a `"tool_count_warning"` field in the `mcp__describe` meta-tool response: `"tool_count_warning": "This agent has 183 tools. Some LLM clients may truncate tool lists; consider reducing guild membership."`

No truncation is performed in v1 — this is a diagnostic aid only.

### 12.4 `notifications/tools/list_changed` triggers

- Upstream server added to / removed from a guild the agent belongs to
- Agent's guild membership changes (guild added or removed)
- Direct server added to / removed from agent
- Upstream server globally enabled / disabled (if agent uses it)
- Upstream server reconnects after error (if agent uses it)

The proxy emits parallel notifications for resources and prompts following the same trigger rules:

| Notification                           | Condition                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `notifications/tools/list_changed`     | Any of the 5 listed triggers, if proxy declared `tools` capability                                |
| `notifications/resources/list_changed` | Same triggers, if proxy declared `resources` capability and affected upstream(s) expose resources |
| `notifications/prompts/list_changed`   | Same triggers, if proxy declared `prompts` capability and affected upstream(s) expose prompts     |

Notifications are only sent for capability types that were declared in the `initialize` response.

### 12.5 Error handling

| Scenario                                                    | Behavior                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream fails at session start                             | Skip, log, continue with remaining                                                                                                                                                                                                                              |
| Upstream disconnects mid-session                            | Mark disconnected, emit `tools/list_changed`, calls to it return `isError: true`                                                                                                                                                                                |
| SSE upstream drops mid-session                              | Mark disconnected, emit `tools/list_changed`, that upstream's tools are removed from `tools/list` for the remainder of the session. No automatic reconnect within the session — reconnect attempted at next session start.                                      |
| Agent unassigned while connected                            | Emit `tools/list_changed`, `tools/list` returns empty                                                                                                                                                                                                           |
| `tools/call` with unknown prefix                            | Return `isError: true`, message: `"Unknown upstream alias: 'xyz'"`                                                                                                                                                                                              |
| `tools/call` with no `__` separator                         | Return `isError: true`, message: `"Tool name must be prefixed with an alias: '{name}'"`                                                                                                                                                                         |
| `tools/call` to disconnected upstream                       | Return `isError: true`, message: `"Upstream 'github' is not available"`                                                                                                                                                                                         |
| Alias collision (two servers same alias)                    | Rejected at API write time — 409 Conflict. Alias uniqueness is **global** — two servers cannot share an alias regardless of guild membership.                                                                                                                   |
| Alias equals `mcp`                                          | Rejected at write time — 409 Conflict. The alias `mcp` is reserved; the `mcp__` tool prefix is used exclusively for proxy self-description tools (§12.2). Aliases that start with `mcp` but are not exactly `mcp` (e.g. `mcptools`, `mcpserver`) are permitted. |
| `resources/read` URI not matching any `mcp+{alias}:` prefix | Return JSON-RPC error `{ "code": -32002, "message": "Resource not found: unknown URI scheme" }`                                                                                                                                                                 |
| `resources/read` where owning upstream is disconnected      | Return JSON-RPC error `{ "code": -32002, "message": "Resource not found: upstream '{alias}' is not available" }`                                                                                                                                                |
| `prompts/get` with no `__` separator                        | Return JSON-RPC error `{ "code": -32602, "message": "Prompt name must be prefixed with an alias: '{name}'" }`                                                                                                                                                   |
| `prompts/get` with unknown alias prefix                     | Return JSON-RPC error `{ "code": -32602, "message": "Unknown upstream alias: '{alias}'" }`                                                                                                                                                                      |
| `prompts/get` where owning upstream is disconnected         | Return JSON-RPC error `{ "code": -32602, "message": "Upstream '{alias}' is not available" }`                                                                                                                                                                    |
| `completion/complete` forwarding failure                    | Return JSON-RPC error `{ "code": -32603, "message": "Completion request failed: {upstream error}" }`                                                                                                                                                            |
| `resources/subscribe` (any)                                 | Return JSON-RPC error `{ "code": -32601, "message": "Method not found: resource subscriptions are not supported" }`                                                                                                                                             |

**Tool name collision with meta-tools:** Because tool routing splits only on the **first** `__`, an upstream tool whose original name contains `__` (e.g. `mcp__describe`) will never be misrouted to the meta-tool handler. After namespacing it becomes `{alias}__mcp__describe`; the router extracts alias `{alias}` and forwards `mcp__describe` as the original tool name to the correct upstream. The meta-tool handler is invoked only when the alias portion (before the first `__`) is exactly `mcp`.

### 12.5.1 Error Propagation Between Layers

Errors originate at three distinct layers and must be transformed as they cross boundaries. This table is normative — every error that crosses a layer boundary MUST follow the transformation described.

```
Layer              Error type                Propagation rule
────────────────── ──────────────────────── ──────────────────────────────────────────
Upstream transport  Network/protocol errors  UpstreamManager catches, transitions the
(stdio/HTTP/SSE)                             UpstreamHandle to "error" state. Emits
                                             'upstream.error' on the event bus. Does
                                             NOT throw to the caller.

Upstream transport  spawn ENOENT             UpstreamManager catches, logs ERROR with
(stdio)                                      command name, marks upstream "error". Does
                                             NOT crash the session — other upstreams
                                             for the session are unaffected.

Aggregator engine   tools/call forwarded to  Engine returns MCP tool result with
                    errored upstream         isError: true (per §12.5). Does NOT
                                             throw a JSON-RPC error code.

Aggregator engine   Unknown alias prefix     Engine returns isError: true immediately
                    in tools/call            without contacting any upstream.

Aggregator engine   Session in DRAINING or   Engine returns isError: true with message
                    CLOSED when call arrives "Session is closing" (no upstream contact).

Config loader       YAML parse error on      ConfigLoader logs ERROR, retains previous
                    hot reload              ResolvedConfig, does NOT emit config.changed.
                                             Does NOT throw to the watcher.

Config loader       YAML parse error on      ConfigLoader throws; entry point catches,
                    initial load            logs FATAL, exits with code 1.

Config store (DB)   SQLite BUSY (after 5s    ConfigStore throws a typed
                    busy_timeout)           ConfigStoreError { code: "db_busy" }.
                                             Callers that cannot retry MUST return
                                             HTTP 503 or MCP JSON-RPC -32603.

Config store (DB)   Migration failure        ConfigStore throws; entry point catches,
                    at startup              logs FATAL, exits with code 1.

REST API handler    Unhandled exception      Express error middleware catches, logs
                    in route handler        ERROR with stack trace, returns HTTP 500
                                             with generic body (no stack in response).

REST API handler    Validation error         Returns HTTP 400/422 with
                    (Zod/manual)            { error, code } (§9.0). Never leaks
                                             internal type information.
```

**Structured error type for upstream failures:**

```typescript
export class UpstreamError extends Error {
  constructor(
    public readonly code:
      | 'connect_timeout'
      | 'spawn_failed'
      | 'protocol_error'
      | 'upstream_disconnect'
      | 'call_timeout',
    public readonly alias: string,
    public readonly serverId: string,
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
  }
}
```

`UpstreamError` is the only error type that may be constructed by the upstream manager. All other layers MUST use their own typed error classes or plain `Error`. Cross-layer type leakage (e.g. an `UpstreamError` surfacing in a REST API response) is a bug.

### 12.6 Pagination

**v1 position:** The proxy exhausts all pages from each upstream's `tools/list`, `resources/list`, and `prompts/list` before merging and returning a single flat response. No proxy-level pagination cursor is exposed in v1. This means `tools/list` (and equivalent) always returns a complete list in one response.

**Implementation requirement:** The upstream connection manager MUST follow `nextCursor` from each upstream until exhausted before returning results to the aggregator engine. Upstreams that do not paginate (no `nextCursor` in response) are handled normally.

**Rationale:** Most MCP servers do not paginate tool lists. Proxy-level cursor multiplexing adds significant complexity. The risk of exceeding HTTP response size limits is low for v1 tool counts. Pagination will be revisited when per-agent tool limits (Open Question #6) are addressed.

---

## 13. Technology Stack

Standalone Node.js/TypeScript service living in `mcp-proxy/` directory. Scaffold follows [mcpdotdirect/template-mcp-server](https://github.com/mcpdotdirect/template-mcp-server) conventions, adapted for the official MCP SDK and the aggregator's multi-component architecture.

| Layer             | Technology                        | Rationale                                                        |
| ----------------- | --------------------------------- | ---------------------------------------------------------------- |
| Runtime           | Node.js 22                        | LTS, same as monorepo                                            |
| Language          | TypeScript 5 (strict)             | Consistent with monorepo                                         |
| MCP SDK           | `@modelcontextprotocol/sdk`       | Official SDK                                                     |
| HTTP server       | Express 5                         | Consistent with `server/` package                                |
| Database          | `better-sqlite3` + `drizzle-orm`  | Embedded, zero-config, consistent ORM                            |
| Web UI            | React 19 + Vite 6                 | Consistent with `ui/` package                                    |
| UI components     | Tailwind CSS 4 + Radix UI         | Consistent with `ui/` package                                    |
| Build (server)    | esbuild                           | Consistent with `cli/` package                                   |
| Build (UI)        | Vite                              | Consistent with `ui/` package                                    |
| Tests             | Vitest                            | Consistent with monorepo                                         |
| File watching     | chokidar                          | Reliable cross-platform; handles NFS and container volume mounts |
| Process mgmt      | Node `child_process`              | stdio upstream spawning                                          |
| Linting           | ESLint + Prettier                 | Code quality and formatting                                      |
| Commit convention | Conventional Commits + commitlint | Enforced via husky pre-commit hook                               |
| Versioning        | Changesets                        | Changelog generation + semver                                    |

**Reference implementation:** `sparfenyuk/mcp-proxy` (Python) — useful for 1:1 transport bridging patterns and the `@modelcontextprotocol/sdk` session handling idioms. Our implementation extends this with N:1 aggregation, guild/agent routing, namespacing, and web UI.

**Note on DB tech:** The rest of the Paperclip monorepo uses PGlite/PostgreSQL + Drizzle. `mcp-proxy` deliberately uses `better-sqlite3` — it is a standalone service with no external dependencies, and SQLite's embedded model matches that constraint. The Drizzle layer keeps schema/query patterns consistent between the two.

---

## 14. Implementation Milestones

### Milestone 0 — Project scaffold & standards

- [ ] Init repo from [mcpdotdirect/template-mcp-server](https://github.com/mcpdotdirect/template-mcp-server) layout
- [ ] `package.json` with all scripts (`dev`, `build`, `typecheck`, `lint`, `test:run`, `db:generate`, `db:migrate`)
- [ ] `tsconfig.json` + `tsconfig.build.json` (strict, ES2022, NodeNext modules)
- [ ] ESLint + Prettier config
- [ ] Vitest config (`vitest.config.ts`)
- [ ] Husky + commitlint (Conventional Commits)
- [ ] Changesets config (`.changeset/config.json`)
- [ ] GitHub Actions: `ci.yml` and `release.yml` (see §16)
- [ ] `Dockerfile` + `docker-compose.yml` (see §16)
- [ ] `README.md` with quickstart covering: one-command install (`npx mcp-aggregator start` or Docker run one-liner), minimal `mcp.yaml` (one stdio server, one guild, one agent), Claude Code `.claude/mcp.json` snippet pointing to the running proxy, Claude Desktop `claude_desktop_config.json` snippet using the stdio wrapper, troubleshooting: "agent shows 0 tools" → assign a guild. Include `.gitignore` entry for `mcp.yaml` and warning against literal secrets.

### Milestone 1 — Core proxy, no agents/guilds

- [ ] SQLite schema + migrations (drizzle): all tables, including `default` guild seed and `server_tool_cache`
- [ ] Upstream Connection Manager: stdio transport
- [ ] Aggregator Engine: tool merge + namespacing
- [ ] Basic MCP Server: `/mcp` endpoint, Streamable HTTP, initialize + tools/list + tools/call
- [ ] CLI: `mcp-aggregator start` (flags: `--port`, `--api-port`, `--public-url`, `--home`, `--bind`), `mcp-aggregator validate`, `mcp-aggregator migrate`; exit code 1 on startup failure; loads `mcp.yaml` (§3.1) using chokidar, watches for changes
- [ ] Unit tests: namespacing, routing, merge logic

### Milestone 2 — Agent & Guild routing

- [ ] Agent Router: `/mcp/agents/:id`, `/mcp/guilds/:slug`, `/mcp/guilds/:slug1,:slug2,...` endpoints
- [ ] Agent auto-registration on first connect (session_count increment in same transaction)
- [ ] Multi-guild capability resolution (union + deduplication)
- [ ] Direct server assignments per agent (additive to guilds)
- [ ] Server deduplication: same server in multiple guilds = one upstream connection
- [ ] Self-declared guild hints from `clientInfo.name` (with slug-only pattern check) — must include integration tests: hint applied on first connect; hint ignored on reconnect; partial invalid hint discarded entirely with WARN logged; `clientInfo.name = "Claude Code 1.2.3"` not treated as hint
- [ ] Proxy self-description tools: `mcp__describe`, `mcp__tools_by_server`, `mcp__status`
- [ ] `server_tool_cache` upsert after each successful upstream connection
- [ ] Integration tests: multi-guild routing, deduplication, direct assignments

### Milestone 3 — REST API + Hot reload

- [ ] Express app at `/api` (same port as MCP server)
- [ ] Full agent CRUD endpoints including bulk guild replace `PUT /agents/:id/guilds` and bulk server replace `PUT /guilds/:id/servers` (§9 tables)
- [ ] Full guild CRUD endpoints
- [ ] Upstream server CRUD + test endpoint with full response schema (§9.0.4, `timeout_ms` honoured)
- [ ] Session list (`GET /sessions`, `GET /sessions/:id`) + force-close endpoint
- [ ] In-process event bus
- [ ] Hot reload: config change → reconnect → `tools/list_changed` broadcast
- [ ] Audit log table (§9.6) — all write operations generate entries
- [ ] CSRF protection: `Content-Type: application/json` enforced on write endpoints (§9.0)
- [ ] Rate limiting (§9.0): agent registration, test endpoint, write endpoints; `X-RateLimit-*` and `Retry-After` response headers (§9.0.3)
- [ ] Idempotency key support for write endpoints (§9.0.6) — `idempotency_cache` table in SQLite
- [ ] `GET /api/events` SSE endpoint (§9.0.8) — publishes `session.opened`, `session.closed`, `upstream.error`, `upstream.recovered`, `config.reloaded`, `agent.registered` events; keepalive `ping` every 30s; 60-second replay buffer for `Last-Event-ID` reconnects
- [ ] `GET /api/status` with full response schema (§9.4.2)
- [ ] `GET /health` with full response schema (§9.4.1)
- [ ] `GET /api/openapi.json` — static OpenAPI 3.1 spec generated from Zod schemas (§9.0.7)
- [ ] `GET /api/docs` — Swagger UI (development only)
- [ ] SIGHUP handler for manual config reload (in addition to chokidar), for environments where file watching is unreliable
- [ ] List endpoint filtering and sorting query params (§9.0.5) on all list endpoints
- [ ] Integration tests: hot reload scenarios, API tests, SSE event ordering, idempotency key replay

> Note: REST API and hot reload are co-developed in this milestone because the hot reload event bus is triggered by API writes. Separating them into sequential milestones would require stubbing the API in milestone 3.

### Milestone 4 — HTTP upstreams

- [ ] Upstream Connection Manager: Streamable HTTP transport
- [ ] Upstream Connection Manager: SSE (legacy) transport
- [ ] SSE disconnect handling: mark disconnected mid-session, no auto-reconnect within session
- [ ] Integration tests: HTTP upstream scenarios

### Milestone 5 — Web UI

- [ ] Vite + React app scaffold, served at `/` on MCP port
- [ ] Dashboard with live status (auto-refetch every 5s)
- [ ] Agent list + detail (tool list with source attribution, session history, connection URL copy)
- [ ] Guild list + detail (server list, agent list, tool preview from cache)
- [ ] Server list + detail (disable/enable toggle — only write action)
- [ ] Session monitor (force-close — only write action)
- [ ] Tool browser (filterable by guild/server/agent, sourced from `server_tool_cache`)
- [ ] XSS prevention: all user-controlled fields rendered as text, guild color validated as `^#[0-9a-fA-F]{6}$`, no `dangerouslySetInnerHTML` for any database-sourced field

### Milestone 6 — Resources, Prompts, stdio wrapper, Polish

- [ ] Resource aggregation with `mcp+{alias}://` URI prefixing
- [ ] Prompt aggregation
- [ ] Full pagination (proxy-level cursors)
- [ ] `mcp-aggregator-stdio` binary: `--upstream`, `--agent`/`--guild` (mutual exclusion enforced), `--timeout` flags; exits 1 on upstream unavailability at startup; listed in `package.json` `bin` field, built by `build:stdio` script; integration test: starts aggregator, starts stdio wrapper pointing to it, sends `initialize` over stdin, receives tool list
- [ ] Structured JSON logging (see §16.8 for format spec)

### Milestone 7 — Hardening (v2 candidate)

- [ ] API key auth for web UI
- [ ] Encrypted secrets at rest
- [ ] Prometheus metrics endpoint
- [ ] Agent API key auth (for authenticated deployment mode)

---

## 14.1 Extension Points and Plugin Architecture

The v1 architecture deliberately avoids a runtime plugin system — dynamic module loading adds operational complexity that is not justified for a small number of well-known extension types. Instead, the extension model is **compile-time**: new transport adapters, config backends, and auth strategies are registered by editing a small set of registration tables in the source code. This section defines those tables so implementors know exactly where to add new implementations without hunting through the codebase.

### Transport adapters

New upstream transports are added by implementing `IUpstreamHandle` and registering in `src/upstream/manager.ts`:

```typescript
// src/upstream/manager.ts
import { StdioUpstream } from './stdio';
import { StreamableHttpUpstream } from './http';
import { SseUpstream } from './sse';
// To add a new transport: import it and add an entry below.

const TRANSPORT_REGISTRY: Record<TransportType, UpstreamFactory> = {
  stdio: (cfg, sessionId) => new StdioUpstream(cfg, sessionId),
  streamablehttp: (cfg, sessionId) => new StreamableHttpUpstream(cfg, sessionId),
  sse: (cfg, sessionId) => new SseUpstream(cfg, sessionId),
  // websocket:   (cfg, sessionId) => new WebSocketUpstream(cfg, sessionId),  // v2
};
```

A new transport must:

1. Implement `IUpstreamHandle` (all methods including `ping()`)
2. Accept `ResolvedServerConfig` and `sessionId` in its constructor
3. Export a named factory function
4. Be added to the `TRANSPORT_REGISTRY` above
5. Add the new `TransportType` literal to the `transport_type` column's check constraint in the Drizzle schema and to the YAML config validator

No other files need to change for a new transport type.

### Config backends

In v1 the config source is always `mcp.yaml`. Implementors who want to pull config from an external source (Vault, a remote API, Consul KV) implement `IConfigLoader` and substitute it in the entry point:

```typescript
// bin/mcp-aggregator.ts
// Swap YamlConfigLoader for a different implementation here.
const config: IConfigLoader = new YamlConfigLoader(home);
// e.g. const config: IConfigLoader = new VaultConfigLoader(vaultAddr, mountPath);
```

The rest of the system is unaware of the config source. The `IConfigLoader` contract (load, watch) is stable and must be honoured by any implementation.

### Auth strategies (Milestone 7 prep)

Auth is not implemented in v1 but the injection point is identified. The Express app factory accepts an optional `AuthMiddleware` parameter:

```typescript
export function buildExpressApp(opts: {
  engine: IAggregatorEngine;
  store: IConfigStore;
  bus: IEventBus;
  config: IConfigLoader;
  auth?: AuthMiddleware; // undefined = unauthenticated (v1 default)
}): Express;
```

`AuthMiddleware` is a standard Express middleware signature. Milestone 7 passes `ApiKeyAuthMiddleware` here. Agent-level auth uses the same injection point at the MCP route level. No structural changes to the app are needed to add auth.

### Capability middleware hooks (v2 candidate)

A future `CapabilityMiddleware` hook would allow intercepting tool calls before they are forwarded to an upstream — useful for logging, redaction, or synthetic tool injection. This is explicitly out of scope for v1 but the engine should be designed to accommodate it without structural changes: the routing step in `IAggregatorEngine` that calls `handle.callTool(name, args)` is the injection point. A v2 implementation would wrap the handle in a middleware chain.

---

## 15. Open Questions

1. **Guild inheritance** — can a guild extend another guild? (e.g. `senior-qa` extends `qa-engineer` + adds more). v1: no. v2 candidate.
2. **Per-guild alias overrides** — same upstream server in two guilds, but different aliases per guild? v1: alias is global per server, appears once in deduplication.
3. **Sampling forwarding** — if an upstream requests `sampling/createMessage` (server-initiated LLM call), proxy it to client? v1: no.
4. **Resource subscriptions** — forward `notifications/resources/updated` from upstreams? v1: no.
5. **Agent identity verification** — in v1, any client can claim any agent ID in the URL path. v2 should add API key auth per agent.
6. **Tool count limits** — an agent in many guilds with many servers could expose hundreds of tools, exceeding LLM context limits. Consider a per-agent tool limit with priority ordering in v2.
7. **Guild ordering** — when an agent is in multiple guilds and the same upstream appears in both, which guild's membership is shown as the "source" in tool annotations? **Resolved:** the guild with the earliest `added_at` in `agent_guilds`. Specified in §9.1 `source` field schema.
8. **Bulk guild operations (single-agent)** — **Partially resolved:** `PUT /agents/:id/guilds` (§9 Agents table) replaces all guild assignments for a single agent atomically. The broader "assign all agents matching a filter to a guild" operation remains a v2 feature. The `PUT /guilds/:id/servers` endpoint similarly handles bulk server replacement for a guild.
9. **Cross-session upstream pooling** — if 50 sessions for the same agent all connect to the same upstream, each maintains an independent connection. At scale this may be wasteful. Connection sharing across sessions of the same agent (with reference counting) is a v2 concern.
10. **`GET /agents/:id/tools` live mode** — a `?live=true` query parameter could trigger a real upstream connection to enumerate actual available tools (accounting for upstream state), as opposed to the default static DB view. v2 candidate.
11. **SQLite write serialisation under load** — `better-sqlite3` serialises writes on the Node.js thread. With many concurrent session starts (each doing an agent upsert + session INSERT + session_upstreams INSERT), the write lock is held frequently. The `busy_timeout = 5000` pragma mitigates read starvation, but very high concurrency (>100 concurrent session starts) may degrade. Mitigation options: batch session INSERT using a write queue inside `SqliteConfigStore`, or switch to WAL with a single async writer thread. This is a v2 concern; v1 target concurrency is tens of simultaneous sessions.
12. **Event bus ordering under concurrent reloads** — if two REST API writes arrive simultaneously for the same agent (e.g. two guild assignments in rapid succession), both publish `config.changed` events. The engine MUST process these sequentially for a given agent ID to avoid interleaved reconnect cycles. The per-agent FIFO queue in the engine (§8.2) covers this, but the implementation must guard against the case where both events carry the same effective server set and only one reconnect is needed. Deduplication: if the second event arrives while the first reload is still in RELOADING state, the second event is coalesced — the engine remembers the latest desired server set and applies it when the current reload completes, rather than starting a new reload cycle immediately.

---

## 16. CI / CD & Release Workflow

### GitHub Actions

#### `ci.yml` — runs on every PR and push to `main`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test:run
      - run: pnpm build
```

#### `release.yml` — runs on push to `main` (Changesets flow)

```yaml
name: Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile

      # Creates a "Version Packages" PR when changesets are present.
      # Merging that PR triggers the publish step below.
      - uses: changesets/action@v1
        with:
          publish: pnpm release
          title: 'chore: version packages'
          commit: 'chore: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Flow:**

1. Developer creates a changeset with `pnpm changeset` and commits it with their PR
2. On merge to `main`, the `changesets/action` creates (or updates) a "Version Packages" PR that bumps `package.json` and updates `CHANGELOG.md`
3. When that PR is merged, `pnpm release` runs (`pnpm build && changeset publish`), which creates a Git tag and a GitHub release with the changelog notes

#### Docker image (optional, in `release.yml`)

Add after the Changesets step to build and push a Docker image on version tag:

```yaml
- name: Build and push Docker image
  if: steps.changesets.outputs.published == 'true'
  uses: docker/build-push-action@v5
  with:
    context: .
    file: docker/Dockerfile
    push: true
    tags: |
      ghcr.io/${{ github.repository }}:latest
      ghcr.io/${{ github.repository }}:${{ steps.changesets.outputs.publishedPackages[0].version }}
```

### Dockerfile

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app

# Create a non-root user for the runtime container.
# UID 1001 matches the fsGroup set in the Kubernetes Deployment (§16.1).
RUN addgroup -g 1001 -S mcpagg && \
    adduser  -u 1001 -S mcpagg -G mcpagg

ENV NODE_ENV=production
ENV MCP_AGGREGATOR_HOME=/data
ENV MCP_AGGREGATOR_MIGRATION_PROMPT=never

# /data is the persistent volume mount point. Pre-create it so the volume
# mount inherits the correct ownership when fsGroup is applied by Kubernetes.
# In plain Docker (non-K8s), the named volume is also created with correct ownership.
RUN mkdir -p /data && chown mcpagg:mcpagg /data

VOLUME ["/data"]

COPY --from=builder --chown=mcpagg:mcpagg /app/dist ./dist
COPY --from=builder --chown=mcpagg:mcpagg /app/node_modules ./node_modules
COPY --from=builder --chown=mcpagg:mcpagg /app/package.json ./

USER mcpagg

EXPOSE 4000

# Use exec-form ENTRYPOINT so SIGTERM is delivered directly to the Node.js process
# (not via a shell wrapper), ensuring graceful shutdown (§16.5) works correctly.
ENTRYPOINT ["node", "dist/bin/mcp-aggregator.js", "start"]
```

> **stdio upstreams and runtime dependencies:** The Docker image includes Node.js 22 and npm/npx (bundled with Node). Stdio upstream servers that require other runtimes (Python, Go binaries, etc.) must be installed in a custom Dockerfile layer:
>
> ```dockerfile
> FROM ghcr.io/your-org/mcp-aggregator:latest
> RUN apk add --no-cache python3 py3-pip
> ```
>
> Subprocess spawn failures (ENOENT) are logged at ERROR level with the command that failed. Check `GET /servers/:id` or the Server detail page for recent errors.

### `docker-compose.yml`

```yaml
services:
  mcp-aggregator:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports:
      - '127.0.0.1:4000:4000' # WARNING: no agent auth in v1 — bind to loopback only
    volumes:
      # Note: hot-reload (chokidar) may not fire reliably on Docker for Mac due to
      # VirtioFS/osxfs inotify propagation limits. Send SIGHUP for manual reload:
      #   docker kill --signal=HUP <container_name>
      - ./mcp.yaml:/data/mcp.yaml:ro # ro: config is managed on the host; container must not write it
      - mcp-data:/data
    environment:
      # Set to the externally reachable URL agents use to connect.
      # http://localhost:4000 only works when agents run on the same host.
      # WARNING: No agent authentication in v1 — bind to loopback or trusted network only.
      MCP_AGGREGATOR_PUBLIC_URL: 'http://localhost:4000'
      MCP_AGGREGATOR_MIGRATION_PROMPT: 'never'
    env_file:
      # Create a .env file alongside docker-compose.yml for upstream credentials.
      # This file MUST be listed in .gitignore — never commit upstream credentials.
      # Example contents:
      #   GITHUB_TOKEN=ghp_xxx
      #   SLACK_BOT_TOKEN=xoxb-xxx
      - path: ./.env
        required: false # Allows starting without credentials (upstreams that need them will fail to connect)
    healthcheck:
      test:
        [
          'CMD',
          'node',
          '-e',
          "require('http').get('http://127.0.0.1:4000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))",
        ]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s # Allow time for migrations and startup before first health check
    restart: unless-stopped
    stop_grace_period: 30s # Allow graceful session drain (§16.5) before SIGKILL

volumes:
  mcp-data:
```

> When running behind a reverse proxy (e.g. nginx, Caddy, Traefik), set `MCP_AGGREGATOR_PUBLIC_URL` to the public HTTPS URL. Failing to set this causes the UI and `initialize` instructions to show incorrect agent connection URLs.

### Branch & commit conventions

| Branch    | Purpose                                                            |
| --------- | ------------------------------------------------------------------ |
| `main`    | Production-ready. Protected — no direct pushes. All merges via PR. |
| `feat/*`  | New features                                                       |
| `fix/*`   | Bug fixes                                                          |
| `chore/*` | Maintenance, deps, CI                                              |

Commits on feature branches must pass commitlint (enforced via husky). Squash-merge is preferred so `main` history stays clean and each entry is one Conventional Commit.

---

### 16.1 Kubernetes Deployment Manifests

The following manifests represent a production-grade single-replica deployment. See §16.4 for the explicit constraint against running multiple replicas with a shared SQLite volume.

**Namespace and ServiceAccount:**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: mcp-aggregator
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mcp-aggregator
  namespace: mcp-aggregator
  annotations: {} # Add IAM annotations here for cloud workload identity (AWS IRSA, GCP Workload Identity)
```

**ConfigMap (non-secret runtime config):**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp-aggregator-config
  namespace: mcp-aggregator
data:
  MCP_AGGREGATOR_PORT: '4000'
  MCP_AGGREGATOR_MIGRATION_PROMPT: 'never'
  MCP_AGGREGATOR_HOME: '/data'
  MCP_AGGREGATOR_RELOAD_DEBOUNCE_MS: '300'
  MCP_AGGREGATOR_UPSTREAM_CONCURRENCY: '10'
  MCP_AGGREGATOR_TOOL_WARN_THRESHOLD: '128'
  NODE_ENV: 'production'
  # MCP_AGGREGATOR_PUBLIC_URL is NOT set here — it references the externally-reachable
  # URL and must be set per-environment in a patch or a separate Secret.
```

**Secret (sensitive runtime values):**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-aggregator-secrets
  namespace: mcp-aggregator
type: Opaque
# Values are base64-encoded. Manage with a secrets operator (External Secrets Operator,
# Sealed Secrets, or Vault Agent Injector) rather than committing literal base64 here.
stringData:
  MCP_AGGREGATOR_PUBLIC_URL: 'https://mcp.example.com'
  # Upstream credentials referenced by mcp.yaml via ${VAR_NAME} interpolation:
  GITHUB_TOKEN: '' # inject via ESO/Vault
  SLACK_BOT_TOKEN: '' # inject via ESO/Vault
```

**PersistentVolumeClaim (SQLite + mcp.yaml data dir):**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mcp-aggregator-data
  namespace: mcp-aggregator
spec:
  accessModes:
    - ReadWriteOnce # MUST be RWO — SQLite single-writer constraint (see §16.4)
  storageClassName: standard-rwo # Use a provisioner that supports fsGroup (not NFS)
  resources:
    requests:
      storage: 2Gi # SQLite WAL + journal overhead; increase for high session volume
```

**Deployment:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-aggregator
  namespace: mcp-aggregator
  labels:
    app: mcp-aggregator
spec:
  replicas: 1 # MUST be 1 — see §16.4 SQLite single-writer constraint
  strategy:
    type: Recreate # MUST be Recreate (not RollingUpdate) — see §16.5
  selector:
    matchLabels:
      app: mcp-aggregator
  template:
    metadata:
      labels:
        app: mcp-aggregator
      annotations:
        # Force pod restart when ConfigMap or Secret changes:
        checksum/config: '{{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}'
        checksum/secrets: '{{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}'
    spec:
      serviceAccountName: mcp-aggregator
      terminationGracePeriodSeconds: 30 # Must exceed shutdown deadline (10s) + buffer (see §16.5)
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        runAsGroup: 1001
        fsGroup: 1001 # Ensures volume is writable by the process user
        seccompProfile:
          type: RuntimeDefault
      initContainers:
        # Run migrations before the main container starts. Prevents the main process
        # from racing against schema changes on first boot or after an upgrade.
        - name: migrate
          image: ghcr.io/your-org/mcp-aggregator:latest
          command: ['node', 'dist/bin/mcp-aggregator.js', 'migrate']
          envFrom:
            - configMapRef:
                name: mcp-aggregator-config
            - secretRef:
                name: mcp-aggregator-secrets
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
      containers:
        - name: mcp-aggregator
          image: ghcr.io/your-org/mcp-aggregator:latest
          envFrom:
            - configMapRef:
                name: mcp-aggregator-config
            - secretRef:
                name: mcp-aggregator-secrets
          ports:
            - name: mcp
              containerPort: 4000
              protocol: TCP
          volumeMounts:
            - name: data
              mountPath: /data
            - name: mcp-yaml
              mountPath: /data/mcp.yaml
              subPath: mcp.yaml
              readOnly: true # Config is managed outside the container; write only via ConfigMap update
          resources: # See §16.6 for sizing rationale
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          startupProbe: # See §16.2
            httpGet:
              path: /health
              port: mcp
            failureThreshold: 30
            periodSeconds: 2
          readinessProbe: # See §16.2
            httpGet:
              path: /health
              port: mcp
            initialDelaySeconds: 0
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe: # See §16.2
            httpGet:
              path: /health
              port: mcp
            initialDelaySeconds: 0
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 3
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          lifecycle:
            preStop:
              exec:
                # Give the process time to receive SIGTERM and drain sessions before
                # the container is killed. Combined with terminationGracePeriodSeconds.
                command: ['/bin/sh', '-c', 'sleep 5']
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: mcp-aggregator-data
        - name: mcp-yaml
          configMap:
            name: mcp-aggregator-mcp-yaml
            defaultMode: 0600 # Restrict to owner-read/write per §3.1 security requirements
```

**ConfigMap for mcp.yaml:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp-aggregator-mcp-yaml
  namespace: mcp-aggregator
data:
  mcp.yaml: |
    port: 4000
    publicUrl: "${MCP_AGGREGATOR_PUBLIC_URL}"

    servers:
      - alias: github
        name: GitHub Tools
        transport: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"

    guilds:
      - slug: developer
        name: Developer
        servers: [github]

    agents: []
```

> **mcp.yaml in a ConfigMap vs mounted file:** Mounting `mcp.yaml` from a ConfigMap via `subPath` means Kubernetes ConfigMap updates do NOT trigger chokidar file-watch events — the `subPath` mount bypasses the symlink-swap mechanism Kubernetes uses for non-subPath ConfigMap mounts. Operators MUST send `SIGHUP` to the process after a ConfigMap update to trigger a manual reload: `kubectl exec -n mcp-aggregator deploy/mcp-aggregator -- kill -HUP 1`. Alternatively, use the full mount (no `subPath`) with a projected volume and accept that the file appears at a different path within the data directory, or use a rolling restart (`kubectl rollout restart`).

**Service:**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: mcp-aggregator
  namespace: mcp-aggregator
  labels:
    app: mcp-aggregator
spec:
  selector:
    app: mcp-aggregator
  ports:
    - name: mcp
      port: 4000
      targetPort: mcp
      protocol: TCP
  type: ClusterIP # Not LoadBalancer — expose via Ingress with TLS termination (§16.3)
```

---

### 16.2 Health Check Probe Design

The `/health` endpoint (on the primary MCP port) is the single probe target. It is always available on the primary port regardless of two-port layout (see §3).

**`GET /health` response shape:**

```json
{
  "status": "ok",
  "uptime_seconds": 3600,
  "active_sessions": 3,
  "db": "ok",
  "migrations_pending": 0
}
```

When the service is degraded (e.g. DB unreachable), it returns HTTP 503 with `"status": "degraded"` and a `"reason"` field. It never returns 500 — health endpoints must not throw.

**Probe strategy:**

| Probe         | Purpose                                                                                                                                                                                                                                                                                                    | Failure action                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Startup**   | Waits for migrations + YAML parse + port bind to complete. High `failureThreshold` (e.g. 30 × 2s = 60s) to allow slow SQLite migration on large databases.                                                                                                                                                 | Container restarted only after startup period exhausted. |
| **Readiness** | Confirms the process is ready to serve traffic. Fails if the DB is unavailable or migrations are pending (the migration initContainer should prevent the latter). The kubelet removes the pod from Service endpoints while this is failing — prevents traffic routing to a pod mid-startup or mid-restart. | Pod removed from Service endpoints; no traffic routed.   |
| **Liveness**  | Detects a hung or deadlocked process. Lower frequency (15s) to reduce noise. Failing liveness kills and restarts the container — this is a last resort and should not be triggered by transient DB busy events.                                                                                            | Container killed and restarted.                          |

**`/health` implementation requirements:**

- MUST respond within 2 seconds (probe `timeoutSeconds` is set to 3s with 1s margin).
- MUST perform a lightweight DB liveness check: `SELECT 1` against the SQLite connection. A failed check returns HTTP 503.
- MUST NOT perform upstream MCP server connectivity checks — those are dynamic and their failure does not mean the proxy is unhealthy.
- MUST NOT block on SQLite WAL checkpoint or migration steps.
- The endpoint MUST be excluded from request logging middleware to prevent probe-generated log noise.

**Startup vs readiness timing:** The startup probe runs first and disables the liveness probe until it succeeds. Once the startup probe passes, readiness and liveness probes take over. This prevents the liveness probe from killing a legitimately slow-starting pod before it finishes applying migrations.

---

### 16.3 TLS Termination and Reverse Proxy Configuration

TLS MUST be terminated at the ingress layer, not inside the `mcp-aggregator` process. The proxy speaks plain HTTP internally; the ingress controller (nginx, Traefik, or Caddy) handles TLS.

**Kubernetes Ingress (nginx):**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: mcp-aggregator
  namespace: mcp-aggregator
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: '3600' # Long-lived SSE/streaming connections
    nginx.ingress.kubernetes.io/proxy-send-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-buffering: 'off' # Required for SSE — disable response buffering
    nginx.ingress.kubernetes.io/proxy-http-version: '1.1'
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Connection '';                          # SSE: disable connection close on idle
      chunked_transfer_encoding on;
    cert-manager.io/cluster-issuer: 'letsencrypt-prod'
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - mcp.example.com
      secretName: mcp-aggregator-tls
  rules:
    - host: mcp.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: mcp-aggregator
                port:
                  name: mcp
```

**Critical reverse proxy requirements for MCP Streamable HTTP:**

1. **Disable response buffering** (`proxy_buffering off` in nginx, `flush_interval 0` in Traefik). MCP uses chunked streaming; buffering causes agents to hang waiting for a complete response.
2. **Long read/send timeouts** (≥3600s). MCP sessions are long-lived HTTP connections; default 60s proxy timeouts cause spurious disconnections.
3. **HTTP/1.1 keepalive** between ingress and backend. Ensure the `Connection: keep-alive` header is preserved upstream.
4. **Path stripping: none.** The proxy expects paths exactly as presented (`/mcp/agents/:id`, `/api/*`, `/`). Do not configure path rewriting.
5. **WebSocket upgrade not required.** MCP Streamable HTTP uses chunked HTTP/1.1, not WebSocket. Do not add WebSocket upgrade headers.

**Caddy (alternative — recommended for simplicity):**

```caddyfile
mcp.example.com {
  reverse_proxy mcp-aggregator.mcp-aggregator.svc.cluster.local:4000 {
    flush_interval -1          # Immediate flush — required for SSE/streaming
    transport http {
      read_timeout  3600s
      write_timeout 3600s
    }
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
  }
  tls {
    issuer acme
  }
}
```

**Two-port layout with separate ingress routes:**
When `MCP_AGGREGATOR_API_PORT` is set, deploy two Services and two Ingress rules — one routing `/mcp/*` and `/health` to the primary port, another routing `/api/*` and `/` to the API port. This allows different network policies and rate limits per traffic class without requiring split at the application layer.

**`X-Forwarded-*` header handling:** The proxy MUST trust `X-Forwarded-For` and `X-Forwarded-Proto` headers only when the request originates from the ingress controller IP range. Set `trust proxy` in the Express app to `1` (single hop) for standard ingress setups. This ensures rate limiting uses the real client IP (for audit log `actor` field) rather than the ingress pod IP.

---

### 16.4 Horizontal Scaling Constraints (SQLite Single-Writer)

**Hard constraint: run exactly one replica.**

`better-sqlite3` uses SQLite's WAL mode, which supports concurrent reads but serialises all writes through a single process. Running two replicas of `mcp-aggregator` simultaneously against the same `db.sqlite` file will result in write conflicts, corruption under concurrent writes, and undefined hot-reload behaviour (each replica has an independent in-process event bus and session registry).

The Kubernetes Deployment spec in §16.1 mandates `replicas: 1` and `strategy: Recreate` to enforce this.

**Consequences for availability during upgrades:**

- With `Recreate` strategy, there is a brief downtime window between the old pod terminating and the new pod becoming ready (typically 5–20 seconds for migration + startup).
- MCP agents experience this as a connection drop. Agents using `streamablehttp` transport will see the HTTP stream close; they should reconnect automatically.
- Session state in SQLite is preserved across restarts — the crash recovery path (§9.5 step 4) handles any sessions that were active at shutdown.

**Horizontal scaling path (v2):**
To support multiple replicas, the persistence layer must move to a shared external database (PostgreSQL via the Drizzle adapter used by the Paperclip monorepo). The `IConfigStore` interface is the seam — replacing `SqliteConfigStore` with `PostgresConfigStore` is the only structural change required. The in-process event bus must also be replaced with a distributed pub/sub mechanism (e.g. Redis Pub/Sub or PostgreSQL `LISTEN/NOTIFY`) for cross-replica hot-reload events. These changes are captured as a v2 milestone.

**Do not attempt SQLite multi-writer workarounds** (e.g. litestream replication, SQLite over NFS, Litestream with leader election). These patterns add operational complexity without delivering true horizontal write scaling, and some violate SQLite's assumptions about file locking.

---

### 16.5 Graceful Shutdown and Zero-Downtime Deployments

**Shutdown sequence (within the process):**

1. Receive `SIGTERM` (sent by Kubernetes when the pod is being terminated).
2. Stop accepting new HTTP connections (Express server `close()`).
3. For all active MCP sessions: call `engine.closeSession()` concurrently, allowing up to 10 seconds for sessions to drain (per §6.5 graceful shutdown spec).
4. Kill any remaining stdio subprocesses with `SIGKILL` if not exited within the 10s window.
5. Write `disconnected_at` for all sessions not yet persisted.
6. Close the SQLite connection cleanly (allows WAL to checkpoint).
7. `process.exit(0)`.

**Kubernetes `terminationGracePeriodSeconds` must be set to at least 30 seconds.** The process has a 10-second session drain + subprocess kill deadline, plus 5 seconds for the `preStop` hook sleep (to allow the ingress controller to drain its connection pool before SIGTERM is sent), plus buffer for DB writes. If `terminationGracePeriodSeconds` is shorter than the actual shutdown time, Kubernetes sends `SIGKILL` mid-drain, leaving sessions without a written `disconnected_at` (handled by crash recovery on next start, but agents experience an unclean disconnect).

**`preStop` hook:** The Deployment in §16.1 includes a 5-second `preStop` sleep. This gives the kube-proxy and ingress controller time to remove the pod from the active endpoint set before `SIGTERM` is sent and the process stops accepting connections. Without this, a brief window exists where the ingress routes traffic to a pod that has already closed its listener.

**Zero-downtime caveat:** True zero-downtime is not achievable with a single SQLite-backed replica under `Recreate` strategy. The recommended production SLA for upgrades is "brief downtime" (< 30s), not zero-downtime. Document this in runbooks. If zero-downtime is a hard requirement, the v2 PostgreSQL migration path (§16.4) is a prerequisite.

**`SIGHUP` for config reload without restart:** The process registers a `SIGHUP` handler (Milestone 3) that triggers a manual config reload equivalent to chokidar detecting a file change. In Kubernetes, send it as:

```sh
kubectl exec -n mcp-aggregator deploy/mcp-aggregator -- kill -HUP 1
```

Use this after updating the `mcp-aggregator-mcp-yaml` ConfigMap to reload the new config without a pod restart.

---

### 16.6 Container Resource Limits and Requests

Resource sizing depends primarily on:

- Number of concurrent MCP sessions (each holds upstream connections and in-memory session state)
- Number of stdio upstream subprocesses (each is a Node.js child process; `better-sqlite3` adds native module overhead)
- SQLite WAL cache size (`PRAGMA cache_size = -8000` = 8MB baseline)

**Baseline sizing (≤20 concurrent sessions, ≤5 stdio upstreams per session):**

| Resource | Request | Limit | Rationale                                                                                                                                                              |
| -------- | ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU      | 100m    | 1000m | Idle: near-zero. Spikes during session-start (parallel upstream connects) and hot-reload. Cap at 1 CPU to prevent noisy-neighbour on shared nodes.                     |
| Memory   | 128Mi   | 512Mi | Node.js heap + SQLite 8MB WAL cache + per-session upstream handle overhead (~2MB/session estimate). Limit at 512Mi gives headroom for 20 sessions × 5 stdio upstreams. |

**Scaling guidance:**

- Each additional concurrent session adds approximately 2–5 MB of heap (upstream handles, in-flight call tracking, session state).
- Each stdio upstream subprocess contributes its own process overhead outside the Node.js heap — this appears in cgroup memory accounting but not in Node's `process.memoryUsage()`. A Node.js stdio MCP server typically uses 40–80 MB. With 20 sessions × 5 stdio upstreams = 100 subprocesses, add 4–8 GB to memory budgeting.
- For high stdio subprocess counts, deploy stdio upstreams as separate long-running services with `streamablehttp` transport instead of spawning them per session (see §5.3 operational warning).

**Memory limit must not be lower than requests.** If `better-sqlite3`'s WAL checkpoint triggers a spike, the container will be OOMKilled. Set the limit at least 4× the request value.

**Horizontal Pod Autoscaling is not recommended** with a single-replica SQLite deployment. Resource limits provide the only elasticity mechanism; size them conservatively.

---

### 16.7 Network Policy Recommendations

Apply NetworkPolicy resources to restrict MCP and API traffic to expected sources only.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mcp-aggregator-ingress
  namespace: mcp-aggregator
spec:
  podSelector:
    matchLabels:
      app: mcp-aggregator
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow MCP traffic from agent namespaces only:
    - from:
        - namespaceSelector:
            matchLabels:
              role: agent-workload # Label agent namespaces with this
      ports:
        - port: 4000
          protocol: TCP
    # Allow ingress controller to reach the MCP port (for external TLS termination):
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - port: 4000
          protocol: TCP
    # Allow Prometheus scraping if metrics are exposed (Milestone 7):
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 4000
          protocol: TCP
  egress:
    # Allow DNS resolution:
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # Allow HTTP upstream MCP servers within the cluster:
    - to:
        - namespaceSelector:
            matchLabels:
              role: mcp-upstream
      ports:
        - port: 3001
          protocol: TCP
        - port: 3002
          protocol: TCP
    # Allow HTTPS for stdio upstreams that call external APIs (e.g. GitHub):
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
      ports:
        - port: 443
          protocol: TCP
```

**Port exposure principle:** The MCP port (4000) is the only port that should ever reach untrusted networks, and only after authentication is implemented (Milestone 7). In v1, the MCP port MUST be reachable only from agent workload namespaces and the ingress controller. The REST API (same port in single-port layout) inherits the same access restriction — operators access it via `kubectl port-forward` or through the ingress with IP allowlisting.

**Egress to stdio upstream runtimes:** Because stdio subprocesses run inside the container and inherit the container's network namespace, any external API calls made by stdio MCP servers (e.g. `@modelcontextprotocol/server-github` calling `api.github.com`) are subject to the container's egress policy. The HTTPS egress rule above covers public API calls. For private upstream registries, add specific CIDR rules.

---

### 16.8 Structured Logging Format

All log output MUST be newline-delimited JSON (NDJSON) in production (`NODE_ENV=production`). In development, human-readable format is acceptable.

**Log entry schema:**

```json
{
  "ts": "2026-03-10T12:00:00.000Z", // ISO 8601 UTC timestamp
  "level": "info", // trace|debug|info|warn|error|fatal
  "msg": "Session created", // Human-readable message
  "service": "mcp-aggregator",
  "version": "1.2.3", // From package.json version
  "pid": 1,
  "session_id": "uuid", // Present on session-scoped events
  "agent_id": "garry", // Present when known
  "server_id": "uuid", // Present on upstream-scoped events
  "alias": "github", // Present when alias is relevant
  "req_id": "uuid", // Present on HTTP request-scoped events
  "duration_ms": 42, // Present on timed operations
  "error": {
    // Present on warn/error/fatal
    "message": "ENOENT: no such file",
    "code": "ENOENT",
    "stack": "..." // Omitted in production unless log level = debug
  }
}
```

**Required log events and their levels:**

| Event                                 | Level   | Key fields                                            |
| ------------------------------------- | ------- | ----------------------------------------------------- |
| Process started                       | `info`  | `port`, `home`, `version`                             |
| Migration applied                     | `info`  | `migration_name`                                      |
| Crash recovery: stale sessions closed | `info`  | `count`                                               |
| YAML loaded/reloaded                  | `info`  | `servers_count`, `guilds_count`, `agents_count`       |
| YAML parse error (hot reload)         | `error` | `error` (parse message, no secrets)                   |
| Session created                       | `info`  | `session_id`, `agent_id`, `guild_slugs`, `tool_count` |
| Session closed                        | `info`  | `session_id`, `agent_id`, `duration_ms`, `reason`     |
| Upstream connected                    | `info`  | `session_id`, `alias`, `tool_count`, `duration_ms`    |
| Upstream error (connect)              | `warn`  | `session_id`, `alias`, `error.code`, `error.message`  |
| Upstream skipped (timeout)            | `warn`  | `session_id`, `alias`, `timeout_ms`                   |
| Upstream error (keepalive ping)       | `warn`  | `session_id`, `alias`                                 |
| Upstream recovered                    | `info`  | `session_id`, `alias`                                 |
| Guild hint discarded                  | `warn`  | `agent_id`, `unknown_slugs`                           |
| Tool count warning threshold exceeded | `warn`  | `session_id`, `agent_id`, `tool_count`, `threshold`   |
| Config change (reload triggered)      | `info`  | `source`, `affected_agent_count`                      |
| Rate limit exceeded                   | `warn`  | `req_id`, `remote_ip`, `endpoint`                     |
| Subprocess SIGKILL sent               | `warn`  | `session_id`, `alias`, `pid`                          |
| Process shutting down                 | `info`  | `active_sessions`                                     |
| SIGTERM received                      | `info`  | —                                                     |
| Unhandled exception (global handler)  | `fatal` | `error`                                               |

**Secret safety in logging:**

- Env var values and header values MUST NEVER appear in any log entry at any level. Log only key names.
- Upstream server connection config logged at `debug` level MUST omit `env` and `headers` values.
- HTTP request bodies for `PUT /servers/:id/env` and `PUT /servers/:id/headers` MUST be redacted in access logs (log only key names, not values).
- The `error.stack` field is emitted only when `LOG_LEVEL=debug` or `LOG_LEVEL=trace`. In production (`info` and above), stacks are omitted from log output but retained internally for error aggregation tools.

**Log library:** Use [pino](https://github.com/pinojs/pino) (fast, native NDJSON, low overhead, compatible with log aggregation pipelines). Configure with `level` from `LOG_LEVEL` env var (default: `info`). Use `pino-pretty` for development output (`NODE_ENV !== 'production'`).

**Log aggregation:** In Kubernetes, logs written to `stdout`/`stderr` are collected by the node-level log agent (Fluent Bit, Fluentd, or the cloud provider's agent). No sidecar is required. Ensure the deployment's log agent is configured to parse NDJSON and index the `level`, `session_id`, `agent_id`, and `alias` fields for efficient filtering.

---

### 16.9 SQLite Backup and Restore Strategy

`db.sqlite` contains all runtime and audit state (sessions, agent registrations, guild assignments, server tool cache, audit log). Config is in `mcp.yaml` (replicated via ConfigMap). If `db.sqlite` is lost, the service recovers — agents re-register on next connect, tool cache is rebuilt on first upstream connection — but audit history and custom agent/guild metadata created via REST API are lost permanently.

**Backup approach: Litestream continuous replication**

[Litestream](https://litestream.io) replicates SQLite's WAL frames to object storage (S3, GCS, Azure Blob) in near-real-time without taking the database offline or requiring application changes.

Run Litestream as a sidecar container in the same pod:

```yaml
# Add to the Deployment's containers list (alongside the main mcp-aggregator container):
- name: litestream
  image: litestream/litestream:0.3.13
  args: ['replicate']
  env:
    - name: LITESTREAM_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: mcp-aggregator-backup-secrets
          key: AWS_ACCESS_KEY_ID
    - name: LITESTREAM_SECRET_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: mcp-aggregator-backup-secrets
          key: AWS_SECRET_ACCESS_KEY
  volumeMounts:
    - name: data
      mountPath: /data
    - name: litestream-config
      mountPath: /etc/litestream.yml
      subPath: litestream.yml
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      cpu: 100m
      memory: 64Mi
```

```yaml
# ConfigMap: litestream.yml
dbs:
  - path: /data/db.sqlite
    replicas:
      - type: s3
        bucket: your-backup-bucket
        path: mcp-aggregator/db.sqlite
        region: us-east-1
        sync-interval: 10s # WAL frame sync frequency
        retention: 72h # Keep 72h of WAL for point-in-time recovery
        retention-check-interval: 1h
```

**Restore procedure:**

```sh
# Stop the mcp-aggregator pod first (scale to 0 to release the SQLite write lock):
kubectl scale -n mcp-aggregator deploy/mcp-aggregator --replicas=0

# Use an ephemeral pod to restore from the latest snapshot:
kubectl run -n mcp-aggregator litestream-restore \
  --image=litestream/litestream:0.3.13 \
  --restart=Never \
  --overrides='{ "spec": { "volumes": [{ "name": "data", "persistentVolumeClaim": { "claimName": "mcp-aggregator-data" } }], "containers": [{ "name": "litestream-restore", "image": "litestream/litestream:0.3.13", "command": ["litestream", "restore", "-o", "/data/db.sqlite", "s3://your-backup-bucket/mcp-aggregator/db.sqlite"], "volumeMounts": [{ "name": "data", "mountPath": "/data" }], "env": [{ "name": "LITESTREAM_ACCESS_KEY_ID", "valueFrom": { "secretKeyRef": { "name": "mcp-aggregator-backup-secrets", "key": "AWS_ACCESS_KEY_ID" } } }, { "name": "LITESTREAM_SECRET_ACCESS_KEY", "valueFrom": { "secretKeyRef": { "name": "mcp-aggregator-backup-secrets", "key": "AWS_SECRET_ACCESS_KEY" } } }] }] } }'

# Wait for restore to complete, then scale back up:
kubectl wait -n mcp-aggregator pod/litestream-restore --for=condition=Succeeded
kubectl scale -n mcp-aggregator deploy/mcp-aggregator --replicas=1
```

**Point-in-time restore:** Litestream retains WAL frames for the `retention` period (72h above). To restore to a specific timestamp:

```sh
litestream restore -o /data/db.sqlite -timestamp "2026-03-10T10:00:00Z" \
  s3://your-backup-bucket/mcp-aggregator/db.sqlite
```

**Alternative: Periodic snapshot backup (simpler, coarser):**

For deployments where Litestream is operationally complex, a CronJob can take periodic SQLite backups using the SQLite `.backup` command:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: mcp-aggregator-backup
  namespace: mcp-aggregator
spec:
  schedule: '0 * * * *' # Hourly
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: ghcr.io/your-org/mcp-aggregator:latest
              command:
                - /bin/sh
                - -c
                - |
                  TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
                  sqlite3 /data/db.sqlite ".backup /tmp/db-${TIMESTAMP}.sqlite"
                  # Upload to object storage (install aws-cli or mc in the image):
                  aws s3 cp /tmp/db-${TIMESTAMP}.sqlite \
                    s3://your-backup-bucket/mcp-aggregator/hourly/db-${TIMESTAMP}.sqlite
              volumeMounts:
                - name: data
                  mountPath: /data
                  readOnly: true # Backup process needs only read access
          volumes:
            - name: data
              persistentVolumeClaim:
                claimName: mcp-aggregator-data
```

> **SQLite `.backup` vs file copy:** Always use `sqlite3 .backup` (or the SQLite Online Backup API) rather than copying the raw `.sqlite` file. A raw file copy may capture the database mid-write and produce a corrupted backup. The `.backup` command takes a consistent snapshot using SQLite's internal checkpointing, even with WAL mode enabled.

**RTO/RPO targets:**

- With Litestream: RPO ≤ 10 seconds (WAL sync interval), RTO ≤ 5 minutes (restore from S3 + pod restart).
- With hourly CronJob: RPO ≤ 1 hour, RTO ≤ 10 minutes.
- The YAML config (in ConfigMap) has RPO = 0 and RTO = 0 (it is version-controlled and applied at deploy time).

---

## 17. Observability & Operations

This section provides the normative specification for metrics, tracing, alerting, SLOs, runbooks, and debug tooling. The goal is that an operator on call has everything needed to diagnose and resolve common failure scenarios without reading source code.

---

### 17.1 Prometheus Metrics Endpoint

**Endpoint:** `GET /metrics`

Available on the primary MCP port. Returns text-format Prometheus metrics (`Content-Type: text/plain; version=0.0.4`). The endpoint MUST respond within 500 ms; if a metric collection step takes longer it is skipped and a `mcp_aggregator_metrics_scrape_errors_total` counter is incremented.

The `/metrics` endpoint MUST be excluded from request logging middleware (same as `/health`) to prevent scrape-generated log noise.

Set `MCP_AGGREGATOR_METRICS_ENABLED=false` to disable the endpoint (default: `true`). When disabled, the endpoint returns HTTP 404.

#### Naming Conventions

All metrics follow the `mcp_aggregator_` prefix. Labels use snake_case. Histogram buckets are tuned to the expected latency distribution of each operation.

#### Complete Metric Catalog

**Session metrics:**

```
# HELP mcp_aggregator_sessions_active Current number of active MCP sessions (ACTIVE or RELOADING state)
# TYPE mcp_aggregator_sessions_active gauge
mcp_aggregator_sessions_active

# HELP mcp_aggregator_sessions_total Total MCP sessions created since process start
# TYPE mcp_aggregator_sessions_total counter
mcp_aggregator_sessions_total{reason="client_connect"}
mcp_aggregator_sessions_total{reason="auto_register"}

# HELP mcp_aggregator_session_duration_seconds Duration of completed MCP sessions
# TYPE mcp_aggregator_session_duration_seconds histogram
mcp_aggregator_session_duration_seconds_bucket{le="1"}
mcp_aggregator_session_duration_seconds_bucket{le="30"}
mcp_aggregator_session_duration_seconds_bucket{le="300"}
mcp_aggregator_session_duration_seconds_bucket{le="3600"}
mcp_aggregator_session_duration_seconds_bucket{le="86400"}
mcp_aggregator_session_duration_seconds_bucket{le="+Inf"}
mcp_aggregator_session_duration_seconds_sum
mcp_aggregator_session_duration_seconds_count

# HELP mcp_aggregator_session_start_duration_seconds Time from session creation to ACTIVE state (upstream connect phase)
# TYPE mcp_aggregator_session_start_duration_seconds histogram
mcp_aggregator_session_start_duration_seconds_bucket{le="0.1"}
mcp_aggregator_session_start_duration_seconds_bucket{le="0.5"}
mcp_aggregator_session_start_duration_seconds_bucket{le="1"}
mcp_aggregator_session_start_duration_seconds_bucket{le="5"}
mcp_aggregator_session_start_duration_seconds_bucket{le="15"}
mcp_aggregator_session_start_duration_seconds_bucket{le="30"}
mcp_aggregator_session_start_duration_seconds_bucket{le="+Inf"}
mcp_aggregator_session_start_duration_seconds_sum
mcp_aggregator_session_start_duration_seconds_count

# HELP mcp_aggregator_sessions_by_state Current sessions broken down by state machine state
# TYPE mcp_aggregator_sessions_by_state gauge
mcp_aggregator_sessions_by_state{state="INITIALIZING"}
mcp_aggregator_sessions_by_state{state="ACTIVE"}
mcp_aggregator_sessions_by_state{state="RELOADING"}
mcp_aggregator_sessions_by_state{state="DRAINING"}

# HELP mcp_aggregator_reloading_duration_seconds Time sessions spend in RELOADING state
# TYPE mcp_aggregator_reloading_duration_seconds histogram
mcp_aggregator_reloading_duration_seconds_bucket{le="0.1"}
mcp_aggregator_reloading_duration_seconds_bucket{le="0.5"}
mcp_aggregator_reloading_duration_seconds_bucket{le="1"}
mcp_aggregator_reloading_duration_seconds_bucket{le="5"}
mcp_aggregator_reloading_duration_seconds_bucket{le="10"}
mcp_aggregator_reloading_duration_seconds_bucket{le="+Inf"}
mcp_aggregator_reloading_duration_seconds_sum
mcp_aggregator_reloading_duration_seconds_count
```

**Upstream metrics:**

```
# HELP mcp_aggregator_upstream_connections_active Current connected upstream handles across all sessions
# TYPE mcp_aggregator_upstream_connections_active gauge
mcp_aggregator_upstream_connections_active{alias="<alias>",transport="stdio|streamablehttp|sse"}

# HELP mcp_aggregator_upstream_connect_duration_seconds Time to complete a single upstream connection
# TYPE mcp_aggregator_upstream_connect_duration_seconds histogram
mcp_aggregator_upstream_connect_duration_seconds_bucket{alias="<alias>",transport="<t>",le="0.1"}
mcp_aggregator_upstream_connect_duration_seconds_bucket{alias="<alias>",transport="<t>",le="0.5"}
mcp_aggregator_upstream_connect_duration_seconds_bucket{alias="<alias>",transport="<t>",le="1"}
mcp_aggregator_upstream_connect_duration_seconds_bucket{alias="<alias>",transport="<t>",le="5"}
mcp_aggregator_upstream_connect_duration_seconds_bucket{alias="<alias>",transport="<t>",le="30"}
mcp_aggregator_upstream_connect_duration_seconds_bucket{alias="<alias>",transport="<t>",le="+Inf"}
mcp_aggregator_upstream_connect_duration_seconds_sum{alias="<alias>",transport="<t>"}
mcp_aggregator_upstream_connect_duration_seconds_count{alias="<alias>",transport="<t>"}

# HELP mcp_aggregator_upstream_connect_errors_total Total upstream connection failures by error type
# TYPE mcp_aggregator_upstream_connect_errors_total counter
mcp_aggregator_upstream_connect_errors_total{alias="<alias>",transport="<t>",error_code="connect_timeout|spawn_failed|protocol_error|upstream_disconnect|call_timeout"}

# HELP mcp_aggregator_upstream_consecutive_errors Current consecutive error count per upstream server
# TYPE mcp_aggregator_upstream_consecutive_errors gauge
mcp_aggregator_upstream_consecutive_errors{alias="<alias>"}

# HELP mcp_aggregator_tool_calls_total Total tool call requests forwarded to upstreams
# TYPE mcp_aggregator_tool_calls_total counter
mcp_aggregator_tool_calls_total{alias="<alias>",result="success|error|timeout"}

# HELP mcp_aggregator_tool_call_duration_seconds Duration of upstream tool call round trips
# TYPE mcp_aggregator_tool_call_duration_seconds histogram
mcp_aggregator_tool_call_duration_seconds_bucket{alias="<alias>",le="0.05"}
mcp_aggregator_tool_call_duration_seconds_bucket{alias="<alias>",le="0.1"}
mcp_aggregator_tool_call_duration_seconds_bucket{alias="<alias>",le="0.5"}
mcp_aggregator_tool_call_duration_seconds_bucket{alias="<alias>",le="1"}
mcp_aggregator_tool_call_duration_seconds_bucket{alias="<alias>",le="5"}
mcp_aggregator_tool_call_duration_seconds_bucket{alias="<alias>",le="30"}
mcp_aggregator_tool_call_duration_seconds_bucket{alias="<alias>",le="+Inf"}
mcp_aggregator_tool_call_duration_seconds_sum{alias="<alias>"}
mcp_aggregator_tool_call_duration_seconds_count{alias="<alias>"}

# HELP mcp_aggregator_subprocesses_active Current count of live stdio subprocess handles
# TYPE mcp_aggregator_subprocesses_active gauge
mcp_aggregator_subprocesses_active{alias="<alias>"}

# HELP mcp_aggregator_subprocess_exits_total Total stdio subprocess exits by signal/code
# TYPE mcp_aggregator_subprocess_exits_total counter
mcp_aggregator_subprocess_exits_total{alias="<alias>",exit_type="clean|sigterm|sigkill|unexpected"}

# HELP mcp_aggregator_keepalive_ping_errors_total Total keepalive ping failures for HTTP upstreams
# TYPE mcp_aggregator_keepalive_ping_errors_total counter
mcp_aggregator_keepalive_ping_errors_total{alias="<alias>"}
```

**Config and reload metrics:**

```
# HELP mcp_aggregator_config_reloads_total Total configuration reload events
# TYPE mcp_aggregator_config_reloads_total counter
mcp_aggregator_config_reloads_total{source="yaml|api",result="success|parse_error|symlink_rejected"}

# HELP mcp_aggregator_config_reload_duration_seconds Time to complete a full config reload cycle (parse + DB sync + session reconnects)
# TYPE mcp_aggregator_config_reload_duration_seconds histogram
mcp_aggregator_config_reload_duration_seconds_bucket{le="0.05"}
mcp_aggregator_config_reload_duration_seconds_bucket{le="0.1"}
mcp_aggregator_config_reload_duration_seconds_bucket{le="0.5"}
mcp_aggregator_config_reload_duration_seconds_bucket{le="1"}
mcp_aggregator_config_reload_duration_seconds_bucket{le="5"}
mcp_aggregator_config_reload_duration_seconds_bucket{le="+Inf"}
mcp_aggregator_config_reload_duration_seconds_sum
mcp_aggregator_config_reload_duration_seconds_count

# HELP mcp_aggregator_agents_total Total registered agents in the config store
# TYPE mcp_aggregator_agents_total gauge
mcp_aggregator_agents_total

# HELP mcp_aggregator_tool_count_by_agent Current tool count per active agent session (most recent session per agent)
# TYPE mcp_aggregator_tool_count_by_agent gauge
mcp_aggregator_tool_count_by_agent{agent_id="<id>"}
```

**Database metrics:**

```
# HELP mcp_aggregator_db_write_duration_seconds Duration of SQLite write operations
# TYPE mcp_aggregator_db_write_duration_seconds histogram
mcp_aggregator_db_write_duration_seconds_bucket{operation="session_open|session_close|tool_cache_replace|yaml_sync|audit_log",le="0.001"}
mcp_aggregator_db_write_duration_seconds_bucket{operation="<op>",le="0.005"}
mcp_aggregator_db_write_duration_seconds_bucket{le="0.01"}
mcp_aggregator_db_write_duration_seconds_bucket{le="0.05"}
mcp_aggregator_db_write_duration_seconds_bucket{le="0.1"}
mcp_aggregator_db_write_duration_seconds_bucket{le="+Inf"}
mcp_aggregator_db_write_duration_seconds_sum{operation="<op>"}
mcp_aggregator_db_write_duration_seconds_count{operation="<op>"}

# HELP mcp_aggregator_db_busy_errors_total Total SQLite SQLITE_BUSY errors (write lock contention beyond busy_timeout)
# TYPE mcp_aggregator_db_busy_errors_total counter
mcp_aggregator_db_busy_errors_total{operation="<op>"}

# HELP mcp_aggregator_wal_checkpoint_pages WAL checkpoint result pages (log and checkpointed)
# TYPE mcp_aggregator_wal_checkpoint_pages gauge
mcp_aggregator_wal_checkpoint_pages{type="log"}
mcp_aggregator_wal_checkpoint_pages{type="checkpointed"}
mcp_aggregator_wal_checkpoint_pages{type="busy"}
```

**HTTP API metrics:**

```
# HELP mcp_aggregator_http_requests_total Total HTTP requests by method, path group, and status
# TYPE mcp_aggregator_http_requests_total counter
mcp_aggregator_http_requests_total{method="GET|POST|PUT|PATCH|DELETE",path_group="/mcp/agents|/mcp/guilds|/api/agents|/api/sessions|/api/servers|/health|/metrics",status_class="2xx|4xx|5xx"}

# HELP mcp_aggregator_http_request_duration_seconds HTTP request duration by path group
# TYPE mcp_aggregator_http_request_duration_seconds histogram
mcp_aggregator_http_request_duration_seconds_bucket{path_group="<group>",le="0.01"}
mcp_aggregator_http_request_duration_seconds_bucket{path_group="<group>",le="0.05"}
mcp_aggregator_http_request_duration_seconds_bucket{path_group="<group>",le="0.1"}
mcp_aggregator_http_request_duration_seconds_bucket{path_group="<group>",le="0.5"}
mcp_aggregator_http_request_duration_seconds_bucket{path_group="<group>",le="1"}
mcp_aggregator_http_request_duration_seconds_bucket{path_group="<group>",le="+Inf"}
mcp_aggregator_http_request_duration_seconds_sum{path_group="<group>"}
mcp_aggregator_http_request_duration_seconds_count{path_group="<group>"}

# HELP mcp_aggregator_rate_limit_rejections_total Requests rejected by rate limiting
# TYPE mcp_aggregator_rate_limit_rejections_total counter
mcp_aggregator_rate_limit_rejections_total{endpoint_group="registration|test|write"}
```

**Process and runtime metrics:**

```
# HELP mcp_aggregator_up 1 if the process is healthy, 0 if degraded
# TYPE mcp_aggregator_up gauge
mcp_aggregator_up

# HELP mcp_aggregator_start_timestamp_seconds Unix timestamp when the process last started
# TYPE mcp_aggregator_start_timestamp_seconds gauge
mcp_aggregator_start_timestamp_seconds

# HELP mcp_aggregator_metrics_scrape_errors_total Metric collection steps that failed or timed out
# TYPE mcp_aggregator_metrics_scrape_errors_total counter
mcp_aggregator_metrics_scrape_errors_total{collector="<name>"}
```

**Implementation note:** Use the `prom-client` npm package (the de facto standard for Node.js Prometheus instrumentation). Register a custom `Registry` (not the default global registry) and mount it at `GET /metrics`. This avoids polluting the global registry with default process metrics that may conflict with other metrics libraries. Include default metrics (`collectDefaultMetrics`) for Node.js GC, heap, and event loop lag — these are essential for diagnosing memory leaks and event loop starvation.

---

### 17.2 Structured Log Field Standardization

Building on §16.8, this section defines the mandatory correlation fields that MUST appear on every log entry that is part of a traceable request chain. These fields enable log-based tracing in systems that do not have a separate trace backend.

#### Mandatory Correlation Fields

| Field        | Type   | When present              | Description                                                                                                                                                                                                                            |
| ------------ | ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `req_id`     | UUID   | All HTTP request handlers | Generated by Express middleware at ingress; forwarded to all downstream calls within that request. Same value for all log entries within a single HTTP request lifecycle.                                                              |
| `session_id` | UUID   | All session-scoped events | The MCP session UUID, present from session creation through session close. Links upstream events, tool calls, and reload events to the session that originated them.                                                                   |
| `agent_id`   | string | When agent is known       | Agent slug. Present on session events, upstream events, and config events. `null` for untracked guild connections.                                                                                                                     |
| `trace_id`   | UUID   | All events                | A new UUID generated at process start that changes on restart. Used to correlate a single process lifetime's events in log aggregation. In v2 when OpenTelemetry is adopted, this field is replaced by the W3C `traceparent` trace ID. |
| `reload_id`  | UUID   | Config reload events      | A unique ID assigned to each reload cycle. Links the config.changed event, all affected session RELOADING transitions, and the resulting tools/list_changed notifications to a single reload cycle.                                    |
| `call_id`    | UUID   | Tool call events          | A unique ID for each `tools/call` invocation, linking the inbound request log, the upstream forward log, and the response log.                                                                                                         |

#### Log Entry Shape (extended from §16.8)

```json
{
  "ts": "2026-03-10T12:00:00.123Z",
  "level": "info",
  "msg": "Tool call forwarded",
  "service": "mcp-aggregator",
  "version": "1.2.3",
  "pid": 1,
  "trace_id": "7f3a2b1c-...",
  "req_id": "a1b2c3d4-...",
  "session_id": "s-uuid",
  "agent_id": "garry",
  "call_id": "c-uuid",
  "alias": "github",
  "tool_name": "github__create_pr",
  "duration_ms": 342
}
```

#### Log Sampling Policy

High-frequency events MUST be sampled in production to prevent log volume from overwhelming aggregation pipelines:

| Event                                 | Default sampling                                   | Override env var                         |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| `tools/list` requests                 | 1-in-10                                            | `MCP_AGGREGATOR_LOG_SAMPLE_TOOLS_LIST`   |
| Keepalive ping success                | 1-in-50                                            | `MCP_AGGREGATOR_LOG_SAMPLE_PING_SUCCESS` |
| `/health` probe requests              | Never logged                                       | —                                        |
| `/metrics` scrape requests            | Never logged                                       | —                                        |
| `tools/call` forwarded                | Always logged at `debug`, sampled 1-in-5 at `info` | `MCP_AGGREGATOR_LOG_SAMPLE_TOOL_CALLS`   |
| Upstream connect/disconnect           | Always logged                                      | —                                        |
| Session create/close                  | Always logged                                      | —                                        |
| Error events (`warn`/`error`/`fatal`) | Never sampled                                      | —                                        |

Sampling is applied per log call site, not per log entry. The sampling decision is stable within a `call_id` — if the initial call is sampled, all related events (forward, response, error) are logged.

---

### 17.3 Distributed Trace Design

Even though `mcp-aggregator` is a single process, instrumenting it with spans provides two benefits: (a) a waterfall view of the upstream connect phase for diagnosing slow session starts, and (b) a timeline of tool call routing for debugging latency spikes in specific upstreams.

In v1, tracing is implemented with a lightweight in-process span recorder that writes structured log entries — no external trace collector is required. The span format is compatible with OpenTelemetry so the logger can be swapped for an OTel exporter in v2 with no code changes to span creation sites.

#### Span Hierarchy for Session Start

```
Session.create (root span)
  ├── ConfigStore.resolveServerSet
  ├── Upstream.connect [alias=github] (parallel)
  │   ├── stdio.spawn
  │   └── mcp.initialize
  ├── Upstream.connect [alias=browser] (parallel)
  │   └── http.connect
  ├── Upstream.connect [alias=slack] (parallel)
  │   └── stdio.spawn  ← ERROR: ENOENT
  ├── Namespace.merge
  └── ConfigStore.writeSession
```

#### Span Hierarchy for Tool Call

```
ToolCall.handle (root span, parent = HTTP request span)
  ├── Router.resolveAlias
  └── Upstream.callTool [alias=github, tool=create_pr]
      └── http.post (or stdio.send)
```

#### Span Hierarchy for Config Reload

```
Reload.cycle [reload_id=<uuid>] (root span)
  ├── ConfigLoader.parse
  ├── ConfigStore.syncFromYaml
  ├── Session.reload [session_id=<id>] (one per affected session, parallel)
  │   ├── Upstream.disconnect [alias=old-server]
  │   ├── Upstream.connect [alias=new-server]
  │   └── MCP.notifyListChanged
  └── EventBus.publish(config.changed)
```

#### Span Fields (Compatible with OpenTelemetry Semantic Conventions)

```typescript
interface Span {
  trace_id: string; // W3C trace ID format (32 hex chars)
  span_id: string; // W3C span ID format (16 hex chars)
  parent_span_id?: string;
  name: string; // e.g. "Upstream.connect"
  start_time: string; // ISO 8601
  end_time: string; // ISO 8601
  duration_ms: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
  events: Array<{ time: string; name: string; attributes?: Record<string, unknown> }>;
}
```

Span log entries are written at `debug` level with `"type": "span"` to distinguish them from normal log entries. Log aggregation pipelines can filter on `type=span` to feed a lightweight trace viewer without storing spans in the primary log index.

**v2 migration path:** When OpenTelemetry is adopted in Milestone 7, the span creation API (`startSpan`, `endSpan`) is the only code that changes — it wraps the OTel SDK instead of writing log entries. All span call sites remain unchanged.

---

### 17.4 SLO Definitions

These SLOs are the authoritative targets for v1. Alert rules in §17.5 fire when these targets are at risk.

#### SLO 1 — Availability

**Definition:** The fraction of `/health` probe attempts that return HTTP 200 in any 5-minute window.

**Target:** 99.5% over a 30-day rolling window.

**Error budget:** 0.5% = 216 minutes per 30 days.

**Measurement:** Prometheus query using the HTTP metrics from §17.1:

```promql
# Availability ratio over 5 min windows
sum(rate(mcp_aggregator_http_requests_total{path_group="/health",status_class="2xx"}[5m]))
/
sum(rate(mcp_aggregator_http_requests_total{path_group="/health"}[5m]))
```

**Notes:** The probe intentionally does not check upstream MCP connectivity (§16.2), so this SLO reflects proxy-layer availability, not end-to-end tool availability. A separate SLO (see SLO 4) covers upstream health.

#### SLO 2 — Session Start Latency

**Definition:** The 95th percentile of `mcp_aggregator_session_start_duration_seconds` (time from HTTP connection to ACTIVE state).

**Target:** p95 ≤ 10 seconds over any 1-hour window.

**Measurement:**

```promql
histogram_quantile(0.95,
  sum(rate(mcp_aggregator_session_start_duration_seconds_bucket[1h])) by (le)
)
```

**Rationale:** Agents block during session start — they cannot call any tools until the session is ACTIVE. Latencies above 10s indicate upstream connectivity problems or resource exhaustion.

#### SLO 3 — Tool Call Error Rate

**Definition:** The fraction of tool call requests that return `isError: true` due to proxy-layer failures (upstream unavailable, timeout, unknown alias), excluding errors that originate in the upstream tool itself.

**Target:** ≤ 1% error rate over any 1-hour window.

**Measurement:**

```promql
sum(rate(mcp_aggregator_tool_calls_total{result="error"}[1h]))
/
sum(rate(mcp_aggregator_tool_calls_total[1h]))
```

**Notes:** Errors where `result="error"` are proxy-layer failures. Tool responses where the upstream returned `isError: true` in its content are not counted here — those are application-layer errors, not proxy errors.

#### SLO 4 — Upstream Availability

**Definition:** For each upstream server alias, the fraction of connection attempts (at session start or retry) that succeed within `timeout_ms`.

**Target:** ≥ 95% success rate per upstream alias over any 1-hour window.

**Measurement:**

```promql
# Per-alias success rate
sum by (alias) (rate(mcp_aggregator_upstream_connect_errors_total[1h]))
/
(
  sum by (alias) (rate(mcp_aggregator_upstream_connect_errors_total[1h]))
  +
  sum by (alias) (rate(mcp_aggregator_upstream_connections_active[1h]))
)
```

**Notes:** Individual upstream failures do not constitute a proxy outage, but an upstream persistently below 95% is degrading agent capability. Alert at per-alias level.

#### SLO 5 — Config Reload Latency

**Definition:** The 99th percentile of `mcp_aggregator_config_reload_duration_seconds` (full reload cycle: parse + DB sync + session reconnects).

**Target:** p99 ≤ 30 seconds.

**Rationale:** During reload, affected sessions enter RELOADING state. Tool calls to reloading upstreams are queued for up to 500 ms then rejected. A reload cycle taking more than 30 seconds indicates a systemic problem (many sessions, slow upstream connects) that materially degrades agent usability.

---

### 17.5 Alert Rules

The following Prometheus alerting rules MUST be configured when running in production. Load them as a `PrometheusRule` resource in Kubernetes or as a rules file in a standalone Prometheus.

```yaml
# mcp-aggregator-alerts.yaml
groups:
  - name: mcp_aggregator_availability
    interval: 30s
    rules:
      - alert: McpAggregatorDown
        expr: mcp_aggregator_up == 0
        for: 1m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: 'MCP Aggregator process is unhealthy'
          description: 'The /health endpoint is returning non-200 or is unreachable. All agent MCP sessions are affected. Check pod logs immediately.'
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/process-down'

      - alert: McpAggregatorAvailabilityBurnRateFast
        # Burns error budget 14x faster than allowed — page immediately
        expr: |
          (
            sum(rate(mcp_aggregator_http_requests_total{path_group="/health",status_class!="2xx"}[5m]))
            /
            sum(rate(mcp_aggregator_http_requests_total{path_group="/health"}[5m]))
          ) > 0.07
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: 'MCP Aggregator: availability SLO fast burn (14x)'
          description: 'Error rate on /health is {{ $value | humanizePercentage }} over 5m. Error budget will be exhausted in ~2 hours.'
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/availability-burn'

      - alert: McpAggregatorAvailabilityBurnRateSlow
        # Burns error budget 3x faster than allowed — warn
        expr: |
          (
            sum(rate(mcp_aggregator_http_requests_total{path_group="/health",status_class!="2xx"}[1h]))
            /
            sum(rate(mcp_aggregator_http_requests_total{path_group="/health"}[1h]))
          ) > 0.015
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: availability SLO slow burn (3x)'
          description: 'Error rate on /health is {{ $value | humanizePercentage }} over 1h. Error budget consumption elevated.'

  - name: mcp_aggregator_sessions
    rules:
      - alert: McpAggregatorSessionStartSlow
        expr: |
          histogram_quantile(0.95,
            sum(rate(mcp_aggregator_session_start_duration_seconds_bucket[15m])) by (le)
          ) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: session start p95 > 10s'
          description: 'Session start p95 is {{ $value | humanizeDuration }}. Agents are waiting too long to get tools. Likely cause: upstream connect timeouts or resource exhaustion.'
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/slow-session-start'

      - alert: McpAggregatorSessionsStuckReloading
        expr: mcp_aggregator_sessions_by_state{state="RELOADING"} > 0
        for: 60s
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: sessions stuck in RELOADING for > 60s'
          description: '{{ $value }} session(s) have been in RELOADING state for over 60 seconds. Expected reload duration is < 30s. Likely cause: upstream failing to connect during reload, or reload cycle not completing.'
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/stuck-reloading'

      - alert: McpAggregatorZeroActiveSessions
        # Only fire during expected working hours — adjust for timezone
        expr: mcp_aggregator_sessions_active == 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: no active sessions for 10 minutes'
          description: 'No MCP sessions are currently active. This may be expected (no agents running), or may indicate agents are unable to connect.'

  - name: mcp_aggregator_upstreams
    rules:
      - alert: McpAggregatorUpstreamConsecutiveErrors
        expr: mcp_aggregator_upstream_consecutive_errors > 3
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: upstream {{ $labels.alias }} has {{ $value }} consecutive errors'
          description: "Upstream '{{ $labels.alias }}' has failed to connect {{ $value }} times in a row. Agents relying on this upstream are receiving 0 tools from it. Check upstream server health."
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/upstream-connect-failure'

      - alert: McpAggregatorUpstreamConsecutiveErrorsCritical
        expr: mcp_aggregator_upstream_consecutive_errors > 10
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: 'MCP Aggregator: upstream {{ $labels.alias }} has {{ $value }} consecutive errors (critical)'
          description: "Upstream '{{ $labels.alias }}' has been failing for an extended period. This is likely a permanent failure requiring operator intervention (dead process, revoked credentials, network partition)."
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/upstream-connect-failure'

      - alert: McpAggregatorSubprocessCountRunaway
        expr: sum(mcp_aggregator_subprocesses_active) > 200
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: subprocess count high ({{ $value }})'
          description: 'Total stdio subprocess count is {{ $value }}. Expected = sessions × stdio_upstreams_per_session. A runaway count indicates sessions are not being cleaned up after disconnect. Check for zombie processes and session close failures.'
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/subprocess-runaway'

      - alert: McpAggregatorAgentZeroTools
        expr: mcp_aggregator_tool_count_by_agent == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: agent {{ $labels.agent_id }} has 0 tools for 5+ minutes'
          description: "Agent '{{ $labels.agent_id }}' has had 0 tools in its active session for over 5 minutes. This usually means no guilds are assigned, or all upstreams for its guilds failed to connect."
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/agent-zero-tools'

  - name: mcp_aggregator_database
    rules:
      - alert: McpAggregatorDbBusyErrors
        expr: rate(mcp_aggregator_db_busy_errors_total[5m]) > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: SQLite BUSY errors detected'
          description: 'SQLite is returning BUSY errors (write lock contention beyond 5s busy_timeout). Requests are returning HTTP 503. Likely cause: high concurrent session starts or a long-running write (YAML sync) blocking reads.'
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/sqlite-busy'

      - alert: McpAggregatorWalCheckpointBusy
        expr: mcp_aggregator_wal_checkpoint_pages{type="busy"} > 50
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: WAL checkpoint has {{ $value }} busy pages'
          description: 'The WAL checkpoint is unable to flush {{ $value }} pages because readers hold open read transactions. If this persists, the WAL file will grow indefinitely. Check for long-running read queries or stale connections.'
          runbook: 'https://wiki.example.com/runbooks/mcp-aggregator/wal-busy'

  - name: mcp_aggregator_tool_calls
    rules:
      - alert: McpAggregatorToolCallErrorRateHigh
        expr: |
          sum(rate(mcp_aggregator_tool_calls_total{result="error"}[5m]))
          /
          sum(rate(mcp_aggregator_tool_calls_total[5m]))
          > 0.05
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: 'MCP Aggregator: tool call error rate {{ $value | humanizePercentage }}'
          description: 'More than 5% of tool calls are returning proxy-layer errors over the last 5 minutes. This indicates upstreams are failing mid-session (after successful connect). Check for network instability or upstream process crashes.'
```

---

### 17.6 Operational Runbooks

#### Runbook 1: Upstream Keeps Failing to Connect

**Symptom:** `McpAggregatorUpstreamConsecutiveErrors` alert firing for alias `X`. Agents report missing tools from that upstream. `consecutive_errors > 3` in `GET /servers/:alias`.

**Diagnosis steps:**

1. Check the server detail page in the web UI: `GET /api/servers` → find the server by alias → check `last_error_message` and `last_error_at`.
2. Use the test endpoint to attempt a live connection: `POST /api/servers/:id/test`. This returns the raw error without affecting any session.
3. For stdio transports: verify the command exists in the container. `kubectl exec -n mcp-aggregator deploy/mcp-aggregator -- which <command>`. A `spawn ENOENT` error means the binary is not in `PATH`.
4. For HTTP transports: verify the upstream URL is reachable from the proxy pod. `kubectl exec -n mcp-aggregator deploy/mcp-aggregator -- curl -sv <upstream_url>`.
5. Check if the upstream's credentials have expired: review `GET /api/servers/:id/env` for key names, then verify the actual credential values are still valid out-of-band (not through the proxy — values are write-only).
6. Check if `MCP_AGGREGATOR_ALLOW_PRIVATE_URLS=false` is blocking a private IP URL that was recently added.

**Resolution options:**

- If binary missing: rebuild the Docker image with the runtime dependency, or switch the upstream to `streamablehttp` transport running as a separate service.
- If credential expired: rotate the credential in the environment source (Vault/ESO), then restart the proxy to pick up the new value (`kubectl rollout restart deploy/mcp-aggregator`). Note: hot reload does NOT re-read env vars.
- If upstream service is down: disable the server globally via `POST /api/servers/:id/disable` to stop failed connect attempts from degrading session start performance. Re-enable when the upstream recovers.
- If network issue: check NetworkPolicy egress rules (§16.7). Verify the upstream's port is whitelisted.

**Escalation:** If the upstream has been down for > 1 hour and cannot be restored, consider removing it from the guild via `DELETE /api/guilds/:id/servers/:server-id` to stop it from appearing as a connection failure in new sessions.

---

#### Runbook 2: All Sessions Suddenly Have 0 Tools

**Symptom:** `McpAggregatorAgentZeroTools` alert fires for multiple agents simultaneously. Dashboard shows all agents with 0 tools. This happened after a config change or process restart.

**Diagnosis steps:**

1. Check `GET /api/status` for `servers.with_errors`. If all upstreams are in error state, the issue is connectivity, not config.
2. Check `GET /api/agents/:id` for any agent — verify `guilds` array is non-empty. If the guilds array is empty for all agents, the YAML sync may have wiped guild assignments.
3. Check logs for `YAML parse error` or `syncFromYaml` failures around the time the problem started. `level=error msg="YAML parse error"` during a reload retains the old config; `level=info msg="YAML loaded/reloaded"` followed by 0 tools suggests the YAML was valid but empty.
4. Check if `MCP_AGGREGATOR_DISABLE_GUILD_ENDPOINTS=true` was accidentally set — this would block untracked guild connections but not agent connections.
5. Check `mcp_aggregator_upstream_connections_active` in Prometheus for each alias — if all are 0, no session has successfully connected any upstream.
6. Verify the `default` guild is not the only guild in the system (`GET /api/guilds`) and that agents have guild assignments (`GET /api/agents`).

**Resolution:**

- If guilds are missing: the YAML may have been saved with an empty `guilds:` block. Restore the YAML from version control and send SIGHUP (`kubectl exec deploy/mcp-aggregator -- kill -HUP 1`).
- If upstreams are all failing: follow Runbook 1 for each failing upstream. The most common cause of sudden all-upstream failure is a credential rotation that invalidated all upstream tokens simultaneously, or a network policy change that blocked egress.
- If the problem is after an upgrade: check the migration log — if a migration altered the `guilds` or `agent_guilds` tables incorrectly, restore from backup (§16.9) and roll back the image.

---

#### Runbook 3: SQLite Write Lock Contention

**Symptom:** `McpAggregatorDbBusyErrors` alert firing. REST API returning HTTP 503 with `code: "db_busy"`. Session starts intermittently failing. Log entries: `level=warn msg="SQLite BUSY" duration_ms=5000`.

**Diagnosis steps:**

1. Check `mcp_aggregator_db_write_duration_seconds` histogram by `operation` label. Identify which operation is taking longest — `yaml_sync` during hot reload is the most common culprit.
2. Check `mcp_aggregator_sessions_active` — if above 50, the high concurrent session-start write volume may be the cause.
3. Check `mcp_aggregator_wal_checkpoint_pages{type="busy"}` — if non-zero and growing, a long-running read transaction is blocking WAL checkpoint, causing the WAL file to grow and write latency to increase.
4. Check for any long-running API requests (use `mcp_aggregator_http_request_duration_seconds` with a high quantile and large time window).
5. `PRAGMA wal_checkpoint(PASSIVE)` during a reload cycle can block if readers are active. Check the reload timing relative to busy errors.

**Resolution:**

- If caused by `yaml_sync` during high-concurrency session start: increase `busy_timeout` via `PRAGMA busy_timeout = 10000` (not currently configurable — requires a code change; create an issue). Short-term: reduce reload frequency by increasing `MCP_AGGREGATOR_RELOAD_DEBOUNCE_MS`.
- If caused by WAL growth: manually trigger a checkpoint during a low-activity window. Accessible via debug endpoint `POST /api/debug/wal-checkpoint` (§17.8).
- If caused by high session concurrency: reduce `MCP_AGGREGATOR_UPSTREAM_CONCURRENCY` to serialize upstream connects more aggressively, reducing write lock hold time per session start.
- If persistent: the write queue pattern described in Open Question #11 is the correct long-term fix — batch session INSERTs through a single async writer.

---

#### Runbook 4: Subprocess Count Runaway

**Symptom:** `McpAggregatorSubprocessCountRunaway` alert firing. `mcp_aggregator_subprocesses_active` climbing continuously. Host OOM risk if not addressed. Pod memory limit at risk of being exceeded.

**Diagnosis steps:**

1. Calculate expected subprocess count: `mcp_aggregator_sessions_active × (stdio upstreams per session)`. Compare to `sum(mcp_aggregator_subprocesses_active)`. If actual > expected, subprocesses are not being cleaned up.
2. Check logs for `Subprocess SIGKILL sent` events without matching `Session closed` events — indicates sessions closed without killing subprocesses.
3. Check `mcp_aggregator_subprocess_exits_total{exit_type="unexpected"}` — unexpected exits indicate upstreams dying on their own; the proxy should be handling this via the `'close'` event on the child process.
4. Check `mcp_aggregator_sessions_by_state{state="DRAINING"}` — if sessions are stuck in DRAINING, their subprocesses are still alive (waiting for in-flight calls to complete). A drain stuck for > 30s indicates in-flight calls that never resolved.
5. Use the debug endpoint `GET /api/debug/subprocesses` (§17.8) to list all tracked PIDs and their associated sessions.

**Resolution:**

- If sessions are stuck in DRAINING: force-close them via `DELETE /api/sessions/:id`. This triggers SIGTERM → SIGKILL on the subprocess chain even if the drain timeout has not elapsed.
- If subprocesses are not being registered in the process registry (a bug): the session cleanup path is not finding them. Restart the proxy (graceful shutdown sends SIGTERM to all processes). File a bug — the process registry in §5.3 MUST be populated on spawn and consulted on cleanup.
- If subprocess exits are unexpected: the upstream MCP server process is crashing on its own. Check its stderr (visible in the proxy's logs if stdio stderr is captured). The upstream may need a restart or a health check.
- **Emergency:** If the pod is approaching OOM, force-close all sessions: `curl -X DELETE http://localhost:4000/api/sessions?force_all=true` (see §17.8 debug endpoint). This sends SIGKILL to all subprocesses immediately.

---

#### Runbook 5: Agent Stuck in RELOADING State

**Symptom:** `McpAggregatorSessionsStuckReloading` alert firing. `mcp_aggregator_sessions_by_state{state="RELOADING"}` > 0 for > 60 seconds. Agents in affected sessions report tool calls failing with `"Upstream 'X' is being reloaded"`.

**Diagnosis steps:**

1. Identify which sessions are in RELOADING state: `GET /api/sessions?status=active` and check `upstream_statuses` for sessions that appear to have mixed statuses (some connected, some still reconnecting).
2. Check logs for `reload_id` to trace the full reload cycle. `level=info msg="Session reload started" reload_id=<id>` should have a matching `level=info msg="Session reload complete" reload_id=<id>`. If only the start is present, the reload is stuck.
3. Check which upstreams are in the pending-connect phase. `mcp_aggregator_upstream_connect_duration_seconds` histogram with a very high quantile over the reload window — if p99 is near `timeout_ms` (30s), upstreams are timing out during the reload connect phase.
4. Check if a concurrent reload event arrived while the first reload was in progress (two rapid config changes). The event bus FIFO queue should serialize these, but a bug here could cause a deadlock.
5. Check the in-flight call reference count for the stuck upstream. If a tool call is stuck in-flight against the old upstream handle (e.g. the upstream is hanging on a response), the teardown is deferred until `timeout_ms` elapses.

**Resolution:**

- If upstreams are timing out during reload connect: the new upstream configuration is unreachable. Fix the upstream, or disable it globally via `POST /api/servers/:id/disable`. The reload cycle will then complete without that upstream.
- If a tool call is stuck in-flight: force-close the session: `DELETE /api/sessions/:id`. This abandons the reload, transitions the session to DRAINING, then CLOSED, and kills all subprocesses.
- If there is a suspected deadlock in the event bus queue: restart the proxy. The crash recovery path (§9.5 step 4) will handle the stale session records.
- After resolution: verify `mcp_aggregator_sessions_by_state{state="RELOADING"}` returns to 0 and the affected agents reconnect successfully.

---

### 17.7 `/health` Endpoint Degraded State Design

Building on §9.4.1, this section defines the precise degraded state semantics and the decision tree for what constitutes "degraded" vs "ok".

#### Degraded Conditions

The `/health` endpoint returns HTTP 503 with `"status": "degraded"` when ANY of the following are true:

| Condition                                                            | `reason` value                 | `db` value |
| -------------------------------------------------------------------- | ------------------------------ | ---------- |
| SQLite `SELECT 1` fails or times out (> 1s)                          | `"db_unavailable"`             | `"error"`  |
| `migrations_pending > 0` at startup                                  | `"migrations_pending"`         | `"ok"`     |
| Session registry is inconsistent (in-memory sessions with no DB row) | `"session_registry_corrupt"`   | `"ok"`     |
| Crash recovery is in progress (step 4 of §9.5 startup sequence)      | `"crash_recovery_in_progress"` | `"ok"`     |

The proxy does NOT return degraded for:

- Upstream MCP servers being unavailable (this is not a proxy health issue)
- High tool counts (logged as warning, not a health failure)
- Config reload in progress (reload is async; health is not affected)
- Active sessions in RELOADING state

#### Extended Degraded Response Schema

```json
{
  "status": "degraded",
  "version": "1.2.3",
  "uptime_seconds": 45,
  "active_sessions": 0,
  "db": "error",
  "db_error": "SQLITE_BUSY: database is locked",
  "reason": "db_unavailable",
  "degraded_since": "2026-03-10T12:00:00.000Z",
  "migrations_pending": 0,
  "checks": {
    "db_ping": { "status": "error", "latency_ms": 1023, "error": "SQLITE_BUSY" },
    "session_registry": { "status": "ok" },
    "crash_recovery": { "status": "ok" }
  }
}
```

The `checks` object allows monitoring systems to distinguish which specific check failed. The `degraded_since` field is the timestamp when the proxy first entered the degraded state — useful for alert suppression (ignore degraded states < 10s, which may be transient during startup).

#### Partial Degradation: `"status": "partial"`

A third status value `"partial"` is returned (HTTP 200) when the proxy is operational but has reduced capability:

| Condition                                                                    | `partial_reason`     |
| ---------------------------------------------------------------------------- | -------------------- |
| `migrations_pending > 0` AND startup is complete (should not occur normally) | `"schema_drift"`     |
| Crash recovery completed but some sessions could not be recovered            | `"partial_recovery"` |
| WAL file size exceeds 100 MB (performance risk)                              | `"wal_size_warning"` |

The `"partial"` status returns HTTP 200 so liveness/readiness probes do not fail — the process is operational. It is informational for monitoring integrations.

```json
{
  "status": "partial",
  "partial_reason": "wal_size_warning",
  "wal_size_bytes": 157286400,
  "version": "1.2.3",
  "uptime_seconds": 86400,
  "active_sessions": 12,
  "db": "ok",
  "migrations_pending": 0
}
```

---

### 17.8 Debug Endpoints

The following endpoints are available under `/api/debug` and are intended for operator use during incident diagnosis. They MUST be protected by the same auth mechanism as other write endpoints (Milestone 7). In v1 (unauthenticated), they MUST NOT be exposed to untrusted networks.

Set `MCP_AGGREGATOR_DEBUG_ENDPOINTS=false` to disable all `/api/debug` endpoints (default: `true` in development, `false` in production). The recommended production posture is to disable debug endpoints and access diagnostic information via the `/api/status` endpoint and structured logs.

| Method   | Path                        | Description                                                                                                                                                                                                                                |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `/api/debug/sessions`       | Full in-memory session registry dump: session ID, state, agent ID, upstream handles with status, in-flight call count, subprocess PID (stdio), and memory estimate. Not sourced from the DB — reflects live in-memory state.               |
| `GET`    | `/api/debug/subprocesses`   | All tracked stdio subprocess PIDs, their associated session IDs, aliases, and process uptime. Useful for diagnosing subprocess count runaway (Runbook 4).                                                                                  |
| `GET`    | `/api/debug/event-bus`      | Recent event bus events (last 100): event type, payload summary, subscriber count, processing duration. Useful for diagnosing stuck reload cycles (Runbook 5).                                                                             |
| `POST`   | `/api/debug/wal-checkpoint` | Trigger a manual `PRAGMA wal_checkpoint(PASSIVE)`. Returns `{ log, checkpointed, busy }` page counts. Use during Runbook 3 to reduce WAL file size.                                                                                        |
| `GET`    | `/api/debug/config`         | Current in-memory `ResolvedConfig` snapshot (the last successfully parsed YAML config). Does NOT include resolved env var values — only key names. Useful for verifying that a YAML reload was applied.                                    |
| `GET`    | `/api/debug/heap`           | Node.js heap statistics (`process.memoryUsage()`). Useful for diagnosing memory leaks in long-running deployments.                                                                                                                         |
| `DELETE` | `/api/debug/sessions`       | Force-close ALL active sessions. Body: `{ "reason": "operator_emergency" }`. Sends SIGTERM to all stdio subprocesses, then SIGKILL after 3s. Use as a last resort during Runbook 4 (subprocess runaway). Returns count of sessions closed. |

**Response example for `GET /api/debug/sessions`:**

```json
{
  "total": 3,
  "sessions": [
    {
      "session_id": "s-uuid-1",
      "state": "ACTIVE",
      "agent_id": "garry",
      "connected_at": "2026-03-10T12:00:00Z",
      "upstreams": [
        {
          "alias": "github",
          "status": "connected",
          "in_flight_calls": 1,
          "transport": "stdio",
          "pid": 1234
        },
        {
          "alias": "browser",
          "status": "connected",
          "in_flight_calls": 0,
          "transport": "streamablehttp"
        }
      ],
      "total_in_flight": 1,
      "memory_estimate_bytes": 2097152
    }
  ]
}
```

---

### 17.9 Web UI Dashboard — Missing Operational Metrics

The current dashboard specification in §10 focuses on agent connectivity and tool availability. The following operational metrics should be added to the dashboard to improve operator awareness during incidents.

#### Recommended Dashboard Additions

**System health panel (below the existing 4-metric summary row):**

```
┌──────────────────────────────────────────────────────────────────┐
│  System Health                                                    │
│  ● Process uptime: 3d 4h 12m                                     │
│  ● WAL size: 2.4 MB  (last checkpoint: 4m ago)                   │
│  ● Config reloads today: 7  (last: 12m ago, source: yaml)        │
│  ● Subprocess count: 45  (≈ 3 sessions × 15 stdio upstreams)     │
│  ● Tool calls (1h): 1,247  ✓ 1,231 success · ✕ 16 errors (1.3%) │
└──────────────────────────────────────────────────────────────────┘
```

**Session timing panel (on the Sessions page `/sessions`):**

Add columns:

- **Session start duration:** How long the session took to reach ACTIVE state. Color-coded: green < 2s, yellow 2–10s, red > 10s.
- **Upstream success rate:** `(connected upstreams / total expected upstreams) × 100%` at session start. A session that started with 3/5 upstreams connected shows "60%".
- **Tool call count:** Total tool calls made in the session lifetime.
- **In RELOADING:** A badge if the session is currently in RELOADING state (visible during active reload).

**Upstream health trend (on the Servers page `/servers`):**

Add a mini sparkline or trend indicator per server showing:

- Connect success rate over the last 24 hours (hourly buckets)
- Average connect duration over the last 24 hours

This allows operators to spot upstreams that are intermittently failing (not currently surfaced — `consecutive_errors` only shows the current streak, not historical patterns).

**Config reload history (new panel on Dashboard):**

A timeline of config reload events (last 20):

```
┌──────────────────────────────────────────────────────────────────┐
│  Config Reload History                         [see all →]        │
│  12m ago  yaml  4 agents affected  2.3s  ✓ success               │
│  1h ago   api   1 agent affected   0.8s  ✓ success               │
│  3h ago   yaml  0 agents affected  1.1s  ✓ success (no change)   │
│  1d ago   yaml  12 agents affected 15.2s ⚠ 2 upstreams skipped   │
└──────────────────────────────────────────────────────────────────┘
```

Data source: `audit_log` table filtered by `event_type LIKE 'config.%'` plus the `mcp_aggregator_config_reloads_total` metric counter.

---

### 17.10 Log Rotation and Retention Strategy

#### Process Log Retention (stdout/stderr)

In Kubernetes, logs written to stdout/stderr are managed by the container runtime (containerd) and the node-level log agent (Fluent Bit / Fluentd). The log rotation policy is configured at the node level, not by the application.

Recommended log agent configuration:

```yaml
# Fluent Bit ConfigMap (example for JSON-structured logs from mcp-aggregator)
[PARSER]
    Name   mcp_aggregator_json
    Format json
    Time_Key ts
    Time_Format %Y-%m-%dT%H:%M:%S.%LZ

[FILTER]
    Name  record_modifier
    Match mcp-aggregator.*
    Record log_source kubernetes

[OUTPUT]
    Name  opensearch
    Match mcp-aggregator.*
    Index mcp-aggregator-logs
    # Retention: configure index lifecycle policy for 30-day retention in the search backend
```

**Retention targets:**

| Log type                                | Retention | Storage                                  | Rationale                                     |
| --------------------------------------- | --------- | ---------------------------------------- | --------------------------------------------- |
| `error` / `fatal` level                 | 90 days   | Hot storage (indexed)                    | Required for incident post-mortems            |
| `warn` level                            | 30 days   | Hot storage (indexed)                    | Upstream errors, rate limits, YAML problems   |
| `info` level                            | 14 days   | Warm storage (indexed, slower)           | Session lifecycle, config reloads             |
| `debug` / `trace` level                 | 3 days    | Cold storage (not indexed)               | High volume; only needed for active debugging |
| Audit log (in SQLite `audit_log` table) | 90 days   | SQLite (pruned by §5.4.8 background job) | Compliance and change tracking                |

#### SQLite Audit Log Retention

The background pruning job specified in §5.4.8 runs weekly and deletes entries older than 90 days. This is the only in-process log rotation. The SQLite `audit_log` table should not grow beyond approximately 500 MB under normal operational volume (assuming < 1,000 write operations per day).

If the audit log grows unexpectedly (check `SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM audit_log`), reduce the retention period via the (future) `MCP_AGGREGATOR_AUDIT_RETENTION_DAYS` env var, or run the prune function manually via a debug endpoint call.

#### WAL File Management

The WAL file (`db.sqlite-wal`) is not a log file in the application sense, but it accumulates data between checkpoints. See §5.4.3 for the checkpoint strategy. The WAL file should be < 10 MB under normal operation. If it exceeds 50 MB, the `McpAggregatorWalCheckpointBusy` alert (§17.5) will fire and the `POST /api/debug/wal-checkpoint` debug endpoint (§17.8) can be used to force a checkpoint.

---

### 17.11 Implementation Checklist for Observability

The following checklist captures the observability work items that span multiple milestones. These MUST be tracked as milestone deliverables, not left as "nice to haves".

| Item                                                                          | Milestone | Priority |
| ----------------------------------------------------------------------------- | --------- | -------- |
| Structured JSON logging with mandatory correlation fields (§17.2)             | 6         | Must     |
| `GET /metrics` Prometheus endpoint with session, upstream, DB metrics (§17.1) | 7         | Must     |
| Span logging for session start and tool call paths (§17.3)                    | 7         | Should   |
| `/health` partial/degraded state with `checks` object (§17.7)                 | 3         | Must     |
| `GET /api/debug/sessions` and `GET /api/debug/subprocesses` (§17.8)           | 3         | Should   |
| `POST /api/debug/wal-checkpoint` (§17.8)                                      | 5         | Should   |
| Alert rules deployed alongside the service (§17.5)                            | 7         | Must     |
| Dashboard additions: system health panel, session timing columns (§17.9)      | 5         | Should   |
| Log sampling middleware (§17.2)                                               | 6         | Should   |
| Audit log pruning background job (§5.4.8)                                     | 3         | Must     |
| `reload_id` field on config reload log events (§17.2)                         | 3         | Must     |
| `call_id` field on tool call log events (§17.2)                               | 3         | Should   |
