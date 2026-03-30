#!/usr/bin/env node

/**
 * Local HTTP CONNECT proxy that redirects connections based on hosts mappings.
 * Used with Playwright MCP's --proxy-server option.
 */

import { createServer, request as httpRequest } from "http";
import { connect as netConnect } from "net";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOSTS_MAP_PATH = join(homedir(), ".playwright-mcp", "_hosts_map.json");

function loadHostsMap() {
  if (!existsSync(HOSTS_MAP_PATH)) return {};
  return JSON.parse(readFileSync(HOSTS_MAP_PATH, "utf-8"));
}

const hostsMap = loadHostsMap();
const PORT = parseInt(process.env.PROXY_PORT || "18999", 10);

const server = createServer((req, res) => {
  const url = new URL(req.url);
  const targetHost = hostsMap[url.hostname] || url.hostname;
  const targetPort = url.port || 80;

  const proxyReq = httpRequest(
    { hostname: targetHost, port: targetPort, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: url.hostname } },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  req.pipe(proxyReq);
  proxyReq.on("error", () => res.destroy());
});

server.on("connect", (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(":");
  const targetHost = hostsMap[hostname] || hostname;
  const targetPort = parseInt(port || "443", 10);

  const serverSocket = netConnect(targetPort, targetHost, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
  });

  serverSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => serverSocket.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[playwright-mcp-proxy] Proxy listening on http://127.0.0.1:${PORT}\n`);
  process.stderr.write(`[playwright-mcp-proxy] ${Object.keys(hostsMap).length} host mapping(s) active\n`);
});
