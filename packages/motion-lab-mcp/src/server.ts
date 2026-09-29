/**
 * Waves Motion Lab MCP server — stdio entry point.
 *
 * Any MCP-compatible agent connects locally over stdio:
 *   node packages/motion-lab-mcp/dist/server.mjs
 * Stdout carries exactly one JSON-RPC message per line; all
 * diagnostics go to stderr so the protocol stream stays clean.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTools } from "./tools.js";
import {
  MCP_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
  fail,
  log,
  ok,
  toolError,
  toolResult,
  type JsonRpcRequest
} from "./protocol.js";
import { resolvePaths } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json");
let pkgVersion = SERVER_VERSION;
try {
  pkgVersion = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? SERVER_VERSION;
} catch {
  /* dist layout without package metadata — fall back */
}

const paths = resolvePaths(process.cwd());
const tools = buildTools(paths);
const byName = new Map(tools.map((entry) => [entry.definition.name, entry.handler]));

let buffer = "";
let shuttingDown = false;
/**
 * In-flight dispatch tracking: stdin EOF must not kill a slow tool.
 * Previously `end` → exit(0) raced every network-backed call (prompt
 * enhancement, provider generations) — the pipe closes the moment the
 * client finishes writing, long before a 15s+ tool resolves. Now EOF only
 * arms shutdown; the process exits when the last dispatch settles.
 */
let stdinEnded = false;
let pendingDispatches = 0;

function maybeExit(): void {
  if (stdinEnded && pendingDispatches <= 0 && !shuttingDown) {
    shuttingDown = true;
    process.exit(0);
  }
}

function send(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function dispatch(raw: string): Promise<void> {
  pendingDispatches += 1;
  try {
    await dispatchInner(raw);
  } finally {
    pendingDispatches -= 1;
    maybeExit();
  }
}

async function dispatchInner(raw: string): Promise<void> {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    send(fail(null, -32700, "Parse error — each stdin line must be one JSON-RPC message."));
    return;
  }
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    send(fail(message.id ?? null, -32600, "Invalid request — need { jsonrpc: '2.0', method }."));
    return;
  }
  const id = message.id ?? null;
  const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};

  try {
    switch (message.method) {
      case "initialize": {
        send(
          ok(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: pkgVersion }
          })
        );
        return;
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        send(ok(id, {}));
        return;
      case "tools/list":
        send(ok(id, { tools: tools.map((entry) => entry.definition) }));
        return;
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const handler = byName.get(name);
        if (!handler) {
          send(fail(id, -32601, `Unknown tool "${name}".`));
          return;
        }
        const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
        try {
          const result = await handler(args);
          send(ok(id, toolResult(result)));
        } catch (error) {
          send(ok(id, toolError(error instanceof Error ? error.message : String(error))));
        }
        return;
      }
      default:
        send(fail(id, -32601, `Method not found: "${message.method}".`));
    }
  } catch (error) {
    send(fail(id, -32603, "Internal error.", error instanceof Error ? error.message : String(error)));
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) void dispatch(line);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExit();
});
process.stdin.resume();

log(`${SERVER_NAME} v${pkgVersion} listening on stdio (workspace: ${paths.root}).`);
