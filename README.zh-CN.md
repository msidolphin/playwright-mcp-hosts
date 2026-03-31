# playwright-mcp-hosts

> 类似 SwitchHosts，为 Playwright MCP 浏览器实现自定义 hosts 映射，无需修改系统 `/etc/hosts`。

## 安装

无需手动安装，通过 `npx` 按需运行即可。

### 配置 MCP 客户端

在 MCP 客户端配置文件中（如 `~/.cursor/mcp.json`）添加：

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

首次运行时会自动创建配置目录 `~/.playwright-mcp/` 并生成默认的 `hosts.json` 配置文件。

### 配置文件查找顺序

配置采用**就近优先**策略（类似 `.editorconfig`）：

1. **工程级**：`$CWD/.playwright-mcp/hosts.json` — 仅对当前项目生效
2. **全局级**：`~/.playwright-mcp/hosts.json` — 所有项目共享

如果工程目录下存在 `.playwright-mcp/hosts.json`，则**完全使用工程配置**，忽略全局配置。

> **注意**：工程级配置依赖 MCP 进程的工作目录（`process.cwd()`）指向项目根目录。
> 要使用工程级配置，需在项目中创建 `.cursor/mcp.json`（而非全局 `~/.cursor/mcp.json`），
> 这样 Cursor 会以项目目录作为工作目录启动 MCP 服务。

### 工程级配置示例

1. 在项目根目录创建 `.cursor/mcp.json`：

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

2. 在项目根目录创建 `.playwright-mcp/hosts.json`（建议加入 `.gitignore`）。

3. 在 Cursor Settings → MCP 中重启 playwright 服务。

### 编辑 hosts 配置

- **全局配置**：编辑 `~/.playwright-mcp/hosts.json`
- **工程配置**：编辑 `<项目>/.playwright-mcp/hosts.json`

编辑后重启 MCP 服务即可生效。

## 方案架构

```
浏览器请求 www.example.com
  → CONNECT 127.0.0.1:18999（本地代理）
  → 查 hosts 映射表：www.example.com → 10.0.0.1
  → TCP 直连 10.0.0.1:443
  → 浏览器与目标服务器完成 TLS 握手
  → 测试环境页面正常加载
```

### 核心原理

Chromium 146+ 的 `--host-resolver-rules` 已不可靠（与系统浏览器共享网络服务进程时会被忽略），因此本方案采用 **本地 CONNECT 代理** + Playwright MCP 的 `--proxy-server` 参数：

1. `launch.mjs`：启动器脚本，负责加载 hosts 配置、启动代理、启动 Playwright MCP
2. `proxy.mjs`：轻量级 HTTP CONNECT 代理，在 TCP 层面根据 hosts 映射重定向连接
3. `hosts.json`：用户配置文件（工程级或全局），支持远程 / 本地 / 内联三种 hosts 来源

### 依赖关系

本包**不将 `@playwright/mcp` 作为硬依赖**，而是在运行时通过 `npx @playwright/mcp@latest` 按需拉取，始终使用最新版本。

## 配置文件说明

`hosts.json` 完整示例：

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

### sources 配置项

| 字段 | 说明 |
|------|------|
| `name` | 名称标识，仅用于日志输出 |
| `type` | `remote`（远程 URL）/ `local`（本地文件）/ `inline`（内联映射） |
| `enabled` | `true` 启用 / `false` 禁用，类似 SwitchHosts 的开关 |
| `url` | `remote` 类型专用，远程 hosts 文件的 URL |
| `path` | `local` 类型专用，本地 hosts 文件路径（支持 `~`） |
| `mappings` | `inline` 类型专用，`{ "域名": "IP" }` 格式 |
| `timeout` | `remote` 类型专用，拉取超时时间（毫秒），默认 5000 |

### 全局配置项

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `ignore_https_errors` | 忽略 HTTPS 证书错误（测试环境通常需要） | `false` |
| `browser` | 浏览器类型：`chrome` / `msedge` / `firefox` / `webkit` | `chrome` |
| `proxy_port` | 本地代理端口 | `18999` |
| `extra_args` | 传递给 Playwright MCP 的额外参数 | `[]` |

> **建议使用 `msedge`**：当系统 Chrome 正在运行时，Playwright 的 Chrome 实例可能共享网络服务进程导致代理设置被忽略。Edge 作为独立进程不受影响。

## 使用方式

### 切换环境

编辑 `hosts.json`，将目标环境的 `enabled` 设为 `true`，其他设为 `false`，然后重启 Playwright MCP。

```json
{
  "sources": [
    { "name": "staging", "enabled": true, ... },
    { "name": "pre-production", "enabled": false, ... }
  ]
}
```

### 关闭 hosts 映射

将所有 sources 的 `enabled` 设为 `false`，重启后浏览器直接访问生产环境（不启动代理）。

### 多源叠加

可以同时启用多个 source，后面的规则会覆盖前面的（同一域名以最后出现的为准）。

### 远程 hosts 文件格式

远程 URL 返回的内容使用标准 hosts 文件格式：

```
# comment
10.0.0.1  www.example.com
10.0.0.1  api.example.com
10.0.0.2  internal.example.com
```
