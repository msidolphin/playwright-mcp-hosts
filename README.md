# playwright-mcp-hosts

[中文文档](README.zh-CN.md)

> Like SwitchHosts for Playwright MCP — custom hosts mapping for browser automation without modifying system `/etc/hosts`.

## Installation

No manual installation required. Run on-demand via `npx`.

### Configure MCP Client

Add the following to your MCP client config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["playwright-mcp-hosts@latest"]
    }
  }
}
```

On first run, the config directory `~/.playwright-mcp/` and a default `hosts.json` will be created automatically.

### Config Lookup Order

Config uses a **project-first** strategy (similar to `.editorconfig`):

1. **Project-level**: `$CWD/.playwright-mcp/hosts.json` — applies to current project only
2. **Global**: `~/.playwright-mcp/hosts.json` — shared across all projects

If a project-level config exists, it takes full precedence and the global config is ignored.

> **Note**: Project-level config relies on the MCP process working directory (`process.cwd()`) pointing to the project root.
> To use project-level config, create `.cursor/mcp.json` in your project (not in the global `~/.cursor/mcp.json`),
> so that Cursor launches the MCP server with the project directory as the working directory.

### Project-Level Config Example

1. Create `.cursor/mcp.json` in the project root:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["playwright-mcp-hosts@latest"]
    }
  }
}
```

2. Create `.playwright-mcp/hosts.json` in the project root (consider adding it to `.gitignore`).

3. Restart the playwright MCP server in Cursor Settings → MCP.

### Edit Hosts Config

- **Global**: edit `~/.playwright-mcp/hosts.json`
- **Project**: edit `<project>/.playwright-mcp/hosts.json`

Restart the MCP server after editing.

## Architecture

```
Browser requests www.example.com
  → CONNECT 127.0.0.1:18999 (local proxy)
  → Lookup hosts map: www.example.com → 10.0.0.1
  → TCP connect to 10.0.0.1:443
  → Browser completes TLS handshake with target
  → Page loads from the target environment
```

### How It Works

Chromium 146+'s `--host-resolver-rules` is unreliable (ignored when sharing network service process with system browser). This tool uses a **local CONNECT proxy** with Playwright MCP's `--proxy-server` option instead:

1. `launch.mjs` — Launcher script: loads hosts config, starts proxy, launches Playwright MCP
2. `proxy.mjs` — Lightweight HTTP CONNECT proxy that redirects connections at the TCP level
3. `hosts.json` — User config file (project-level or global), supporting remote / local / inline host sources

### Dependencies

This package does **not** bundle `@playwright/mcp` as a hard dependency. It fetches the latest version on-demand via `npx @playwright/mcp@latest` at runtime.

## Configuration

Full `hosts.json` example:

```json
{
  "sources": [
    {
      "name": "staging",
      "type": "remote",
      "enabled": true,
      "url": "http://10.0.0.1/hosts",
      "timeout": 10000
    },
    {
      "name": "local hosts file",
      "type": "local",
      "enabled": false,
      "path": "~/.playwright-mcp/test-hosts.txt"
    },
    {
      "name": "inline mappings",
      "type": "inline",
      "enabled": false,
      "mappings": {
        "api.example.com": "10.0.0.100",
        "www.example.com": "10.0.0.101"
      }
    }
  ],

  "ignore_https_errors": true,
  "browser": "msedge",
  "extra_args": []
}
```

### Source Fields

| Field | Description |
|-------|-------------|
| `name` | Label for log output |
| `type` | `remote` (URL) / `local` (file) / `inline` (key-value mappings) |
| `enabled` | `true` to enable / `false` to disable, like SwitchHosts toggles |
| `url` | Remote URL returning a standard hosts file (`remote` type only) |
| `path` | Local hosts file path, supports `~` (`local` type only) |
| `mappings` | `{ "hostname": "ip" }` object (`inline` type only) |
| `timeout` | Fetch timeout in milliseconds, default 5000 (`remote` type only) |

### Global Options

| Field | Description | Default |
|-------|-------------|---------|
| `ignore_https_errors` | Ignore HTTPS certificate errors (usually needed for staging) | `false` |
| `browser` | Browser type: `chrome` / `msedge` / `firefox` / `webkit` | `chrome` |
| `extra_args` | Additional arguments passed to Playwright MCP | `[]` |

> **Tip: Use `msedge`** — When system Chrome is running, Playwright's Chrome instance may share its network service process, causing proxy settings to be ignored. Edge runs as a separate process and is not affected.

## Usage

### Switch Environments

Edit `hosts.json`, set the target environment's `enabled` to `true` and others to `false`, then restart the MCP server.

```json
{
  "sources": [
    { "name": "staging", "enabled": true, ... },
    { "name": "pre-production", "enabled": false, ... }
  ]
}
```

### Disable Hosts Mapping

Set all sources' `enabled` to `false` and restart. The browser will connect directly to production (no proxy).

### Multiple Sources

Multiple sources can be enabled simultaneously. Later rules override earlier ones for the same hostname.

### Remote Hosts File Format

Remote URLs should return content in standard hosts file format:

```
# comment
10.0.0.1  www.example.com
10.0.0.1  api.example.com
10.0.0.2  internal.example.com
```

## Known Issues

### Chromium `--host-resolver-rules` Not Working

On Chromium 146+, even when `--host-resolver-rules` is correctly passed to both the browser and network service processes, DNS overrides may not take effect. This is likely related to changes in Chromium's DNS resolution on macOS. This tool bypasses the browser's DNS resolution entirely by redirecting connections at the TCP level via a CONNECT proxy.

### Chrome Network Service Process Sharing

When system Chrome is already running, Playwright's Chrome instance may share the network service process (`network.mojom.NetworkService`), causing `--proxy-server` and other network-related flags to be ignored. Using `msedge` as the browser avoids this issue.
