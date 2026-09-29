/**
 * Live NVIDIA chat/vision tests — stubbed transport only. No network, no key.
 */
import { describe, expect, it } from "vitest";
import {
  LIVE_CHAT_MODEL_DEFAULT,
  enhanceMotionPrompt,
  liveChatModel,
  liveChatStatus
} from "./nvidia-live.js";
import { CosmosError } from "./cosmos.js";
import type { CosmosFetch } from "./cosmos.js";

function chatTransport(payload: unknown, status = 200): CosmosFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload))
  });
}

const ENV = { NVIDIA_API_KEY: "test-key" };

describe("liveChatModel", () => {
  it("defaults to the verified vision model", () => {
    expect(liveChatModel({})).toBe(LIVE_CHAT_MODEL_DEFAULT);
    expect(liveChatModel({ NVIDIA_CHAT_MODEL: "other/model" })).toBe("other/model");
  });
  it("reports configuration without values", () => {
    expect(liveChatStatus({}).configured).toBe(false);
    const ready = liveChatStatus(ENV);
    expect(ready.configured).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("test-key");
  });
});

describe("enhanceMotionPrompt", () => {
  it("sends system direction + user prompt and returns text only", async () => {
    const seen: { current: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null } = { current: null };
    const transport: CosmosFetch = async (url, init) => {
      seen.current = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "  Enhanced cinematic direction.  " } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }),
        text: async () => ""
      };
    };
    const result = await enhanceMotionPrompt({ prompt: "Letters burst.", mode: "text2video" }, { env: ENV, transport });
    expect(result.enhanced).toBe("Enhanced cinematic direction.");
    expect(result.model).toBe(LIVE_CHAT_MODEL_DEFAULT);
    expect(result.promptTokens).toBe(50);
    expect(seen.current?.headers.Authorization).toBe("Bearer test-key");
    expect(seen.current?.url).toContain("integrate.api.nvidia.com");
    const messages = seen.current?.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].role).toBe("system");
    expect(JSON.stringify(messages[1])).toContain("Letters burst.");
  });
  it("attaches source images as data URIs", async () => {
    let userContent: unknown = null;
    const transport: CosmosFetch = async (_url, init) => {
      const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: unknown }> };
      userContent = body.messages[1].content;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }), text: async () => "" };
    };
    await enhanceMotionPrompt({ prompt: "Push in.", imageBytes: Buffer.from([1, 2, 3]), imageMime: "image/png" }, { env: ENV, transport });
    expect(JSON.stringify(userContent)).toContain("data:image/png;base64,");
  });
  it("refuses without a key and maps HTTP failures", async () => {
    const missing = await enhanceMotionPrompt({ prompt: "x" }, { env: {} }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(CosmosError);
    expect((missing as CosmosError).code).toBe("missing_api_key");
    for (const [status, code] of [[401, "unauthorized"], [404, "endpoint_not_found"], [429, "rate_limited"], [500, "server_error"]] as const) {
      const error = await enhanceMotionPrompt({ prompt: "x" }, { env: ENV, transport: chatTransport({}, status) }).catch((e: unknown) => e);
      expect((error as CosmosError).code).toBe(code);
    }
  });
  it("rejects empty model output and never leaks the key", async () => {
    const error = await enhanceMotionPrompt({ prompt: "x" }, { env: ENV, transport: chatTransport({ choices: [] }) }).catch((e: unknown) => e);
    expect((error as CosmosError).code).toBe("malformed_response");
    expect(String((error as Error).message)).not.toContain("test-key");
  });
});
