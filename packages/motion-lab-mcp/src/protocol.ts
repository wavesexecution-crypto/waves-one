/**
 * Minimal MCP stdio transport — newline-delimited JSON-RPC 2.0.
 *
 * Speaks just enough of the Model Context Protocol for any
 * MCP-compatible agent (OpenCode first, others equally):
 * `initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call`, `ping`. Diagnostics go to stderr; stdout carries
 * exactly one JSON message per line.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const SERVER_NAME = "waves-motion-lab";
export const SERVER_VERSION = "1.0.0";

export function ok(id: string | number | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

export function fail(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown
): string {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error });
}

export function toolResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function toolError(message: string, details?: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const body: Record<string, unknown> = { ok: false, error: message };
  if (details !== undefined) body.details = details;
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

export function log(message: string): void {
  process.stderr.write(`[motion-lab-mcp] ${message}\n`);
}
