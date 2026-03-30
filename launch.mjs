#!/usr/bin/env node

/**
 * Playwright MCP Launcher with Remote Hosts Support
 *
 * Custom hosts mapping via a local CONNECT proxy,
 * bypassing Chromium's unreliable --host-resolver-rules.
 *
 * Config lookup order (project-first):
 *   1. $CWD/.playwright-mcp/hosts.json  (project-level)
 *   2. ~/.playwright-mcp/hosts.json     (global)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_CONFIG_DIR = join(homedir(), ".playwright-mcp");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "hosts.json");
const PROJECT_CONFIG_DIR = join(process.cwd(), ".playwright-mcp");
const PROJECT_CONFIG_PATH = join(PROJECT_CONFIG_DIR, "hosts.json");
const HOSTS_MAP_PATH = join(GLOBAL_CONFIG_DIR, "_hosts_map.json");
const PROXY_SCRIPT = join(__dirname, "proxy.mjs");
const DEFAULT_PROXY_PORT = 18999;

const DEFAULT_CONFIG = {
  sources: [
    {
      name: "example: inline mappings",
      type: "inline",
      enabled: false,
      mappings: {
        "example.com": "127.0.0.1",
      },
    },
  ],
  ignore_https_errors: false,
  browser: "chrome",
  proxy_port: DEFAULT_PROXY_PORT,
  extra_args: [],
};

function ensureGlobalConfigDir() {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    process.stderr.write(`[playwright-mcp] Config dir created: ${GLOBAL_CONFIG_DIR}\n`);
  }
}

function loadConfig() {
  if (existsSync(PROJECT_CONFIG_PATH)) {
    process.stderr.write(`[playwright-mcp] Using project config: ${PROJECT_CONFIG_PATH}\n`);
    return JSON.parse(readFileSync(PROJECT_CONFIG_PATH, "utf-8"));
  }

  ensureGlobalConfigDir();
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    process.stderr.write(`[playwright-mcp] Default config generated: ${GLOBAL_CONFIG_PATH}\n`);
    return DEFAULT_CONFIG;
  }
  process.stderr.write(`[playwright-mcp] Using global config: ${GLOBAL_CONFIG_PATH}\n`);
  return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf-8"));
}

function parseHostsContent(content) {
  const map = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const ip = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const host = parts[i];
      if (host.startsWith("#")) break;
      if (host === "localhost" || host === "broadcasthost") continue;
      map[host] = ip;
    }
  }
  return map;
}

async function fetchRemoteHosts(url, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function loadLocalHosts(filePath) {
  const resolved = filePath.startsWith("~") ? join(homedir(), filePath.slice(1)) : filePath;
  return readFileSync(resolved, "utf-8");
}

async function collectHostsMap(config) {
  const hostsMap = {};

  for (const source of config.sources || []) {
    if (!source.enabled) continue;
    try {
      let content;
      if (source.type === "remote") {
        content = await fetchRemoteHosts(source.url, source.timeout || 5000);
        process.stderr.write(`[playwright-mcp] ✓ Remote hosts loaded: ${source.name || source.url}\n`);
      } else if (source.type === "local") {
        content = loadLocalHosts(source.path);
        process.stderr.write(`[playwright-mcp] ✓ Local hosts loaded: ${source.name || source.path}\n`);
      } else if (source.type === "inline") {
        Object.assign(hostsMap, source.mappings || {});
        process.stderr.write(`[playwright-mcp] ✓ Inline hosts loaded: ${source.name || "inline"}\n`);
        continue;
      }
      if (content) Object.assign(hostsMap, parseHostsContent(content));
    } catch (err) {
      process.stderr.write(`[playwright-mcp] ✗ Failed to load [${source.name || "unknown"}]: ${err.message}\n`);
    }
  }
  return hostsMap;
}

async function main() {
  const config = loadConfig();
  const hostsMap = await collectHostsMap(config);
  const extraArgs = config.extra_args || [];
  const proxyPort = config.proxy_port || DEFAULT_PROXY_PORT;
  const hasHosts = Object.keys(hostsMap).length > 0;

  const args = ["@playwright/mcp@latest", "--isolated", ...extraArgs];

  if (config.browser) {
    args.push("--browser", config.browser);
  }
  if (config.ignore_https_errors) {
    args.push("--ignore-https-errors");
  }

  let proxyProcess = null;

  if (hasHosts) {
    writeFileSync(HOSTS_MAP_PATH, JSON.stringify(hostsMap), "utf-8");
    process.stderr.write(`[playwright-mcp] ${Object.keys(hostsMap).length} host mapping(s) loaded\n`);

    proxyProcess = spawn("node", [PROXY_SCRIPT], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PROXY_PORT: String(proxyPort) },
    });

    await new Promise((r) => setTimeout(r, 500));

    args.push("--proxy-server", `http://127.0.0.1:${proxyPort}`);
    process.stderr.write(`[playwright-mcp] Proxy started: http://127.0.0.1:${proxyPort}\n`);
  } else {
    process.stderr.write("[playwright-mcp] No host rules configured, starting in default mode\n");
  }

  const child = spawn("npx", args, {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });

  const cleanup = () => {
    if (proxyProcess) proxyProcess.kill();
    child.kill();
  };

  child.on("exit", (code) => {
    if (proxyProcess) proxyProcess.kill();
    process.exit(code ?? 0);
  });
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  process.stderr.write(`[playwright-mcp] Failed to start: ${err.message}\n`);
  process.exit(1);
});
