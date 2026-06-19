# wikijs-mcp-http

Native HTTP/SSE MCP server for Wiki.js. A clean, production-oriented replacement for supergateway-based setups.

This fork exists because the original transport layer was janky. We replaced it with Wiki.js's built-in `--http` / SSE support so you get a proper, stable, long-lived MCP server you can actually run behind a reverse proxy.

## Features

- 29 tools (19 read + 10 write) covering pages, comments, tags, assets, users, navigation, and system info
- Full-text search, page tree browsing, link graphs, and version history
- Complete comment system (list, read, create, update, delete)
- Asset and folder management
- Tag management
- System diagnostics and site config
- Optional mutations with multiple safety layers (`WIKI_MUTATIONS_ENABLED`, dry-run mode, confirm tokens, path prefix restrictions)
- Built-in resources: `wikijs://markdown-guide`, `wikijs://mermaid-guide`, `wikijs://api-permissions-guide`
- Typed errors with LLM-friendly messages
- GraphQL client with timeout + exponential backoff
- Sensitive field filtering and input hardening

## Quick Start (HTTP/SSE Mode)

```bash
cp .env.example .env
npm install
npm run build
```

Edit `.env`:

```env
WIKI_BASE_URL=https://your-server
WIKI_API_TOKEN=your_wikijs_jwt_token
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=3200
WIKI_MUTATIONS_ENABLED=false          # set true only when you need writes
WIKI_MUTATION_DRY_RUN=true
```

Run it:

```bash
npm start
```

Connect your MCP client to:

```
https://your-server:3200/sse
```

## Recommended Production Setup (systemd + Caddy)

See the full systemd service and Caddyfile examples in the repo (or the one running at 666temple.love right now).

Basic pattern:

- Run as a dedicated user
- Bind to localhost only
- Put Caddy (or nginx) in front with HTTPS + subdomain (e.g. `mcp.website.com`)
- Use a strong `WIKI_MUTATION_CONFIRM_TOKEN` if you enable writes

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WIKI_BASE_URL` | Yes | - | Your Wiki.js URL (e.g. `https://website.com`) |
| `WIKI_API_TOKEN` | Yes | - | Wiki.js JWT API token |
| `MCP_TRANSPORT` | No | `stdio` | Use `http` for network mode |
| `MCP_HOST` / `MCP_PORT` | No | `0.0.0.0:3200` | Bind address for HTTP mode |
| `WIKI_MUTATIONS_ENABLED` | No | `false` | Enable write tools |
| `WIKI_MUTATION_DRY_RUN` | No | `true` | Preview mutations without writing |
| `WIKI_MUTATION_CONFIRM_TOKEN` | No | (empty) | Extra safety gate — write tools must supply matching `confirm` value |
| `WIKI_ALLOWED_MUTATION_PATH_PREFIXES` | No | (empty) | Comma-separated path prefixes allowed for mutations |

Full reference is in `.env.example`.

## Wiki.js Setup

1. Go to **Administration → API** in Wiki.js and enable API access
2. Create an API key (JWT) with appropriate permissions
3. Paste it into `WIKI_API_TOKEN`

For heavy read usage you usually only need `read:pages` + `read:source` + `read:comments`.

## Mutation Safety

Write tools are **disabled by default**. When enabled they still have multiple guardrails:

- `WIKI_MUTATION_DRY_RUN=true` (default) → tools only preview
- `WIKI_MUTATION_CONFIRM_TOKEN` → forces you to pass a matching `confirm` argument on every write
- `WIKI_ALLOWED_MUTATION_PATH_PREFIXES` → scope writes to specific path prefixes
- All mutation attempts are logged to stderr with structured audit info

## MCP Client Config

### HTTP/SSE (recommended)

```json
{
  "mcpServers": {
    "wikijs": {
      "command": "node",
      "args": ["/path/to/wikijs-mcp-http/dist/index.js"],
      "env": {
        "WIKI_BASE_URL": "https://website.com",
        "WIKI_API_TOKEN": "your_token",
        "MCP_TRANSPORT": "http",
        "MCP_PORT": "3200"
      }
    }
  }
}
```

### Stdio (local only)

Still supported if you prefer the classic style.

## Development

```bash
npm run dev          # HTTP dev server with hot reload
npm run dev:stdio    # stdio dev mode
npm run build
```

## License

CC0. Do whatever the fuck you want with it.

---

Maintained as part of the 666 Grimoire stack.
