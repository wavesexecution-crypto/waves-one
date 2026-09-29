/**
 * Cosmos3-Nano hosted-contract unit tests — every NVIDIA touchpoint is a
 * stubbed transport. No network, no credentials, no real generations.
 * Live wire verification lives in test/cosmos-live.mjs (manual, key-gated).
 */
import { describe, expect, it } from "vitest";
import {
  COSMOS_DEFAULT_TIMEOUT_MS,
  COSMOS_MODEL_ID,
  COSMOS_PROVIDER_ID,
  CosmosError,
  buildCosmosRequestBody,
  cosmosApiKey,
  cosmosAuthMode,
  diagnoseCosmosConfig,
  executeCosmosGeneration,
  isMp4Bytes,
  parseCosmosResponse,
  resolveCosmosTimeout,
  resolveResolution,
  selectedMotionProviderId,
  validateCosmosSettings,
  validateMotionRequest,
  type CosmosFetch,
  type MotionGenerationRequest
} from "./cosmos.js";

function mp4Bytes(size = 2048): Buffer {
  const bytes = Buffer.alloc(size, 0xab);
  bytes.writeUInt32BE(16, 0);
  bytes.write("ftyp", 4);
  bytes.write("isom", 8);
  return bytes;
}

function okTransport(payload: unknown): CosmosFetch {
  return async () => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
}

function statusTransport(status: number, body = "error-body"): CosmosFetch {
  return async () => ({ ok: false, status, json: async () => ({}), text: async () => body });
}

function baseRequest(overrides: Partial<MotionGenerationRequest> = {}): MotionGenerationRequest {
  return {
    provider: COSMOS_PROVIDER_ID,
    model: COSMOS_MODEL_ID,
    mode: "text2video",
    prompt: "A premium black and silver object floating in a dark studio.",
    settings: {},
    ...overrides
  };
}

const ENV = { NVIDIA_API_KEY: "test-key", MOTION_PROVIDER: "cosmos" };

describe("resolution contract", () => {
  it("resolves bare tiers to 16:9 aliases", () => {
    expect(resolveResolution("480")).toMatchObject({ key: "480_16_9", w: 832, h: 480, tier: "480" });
    expect(resolveResolution("480_9_16")).toMatchObject({ w: 480, h: 832 });
  });
  it("rejects unknown resolution keys", () => {
    expect(() => resolveResolution("1080p")).toThrowError(CosmosError);
  });
});

describe("validateCosmosSettings", () => {
  it("fills registry defaults", () => {
    const settings = validateCosmosSettings({});
    expect(settings).toMatchObject({ resolution: "720_16_9", numFrames: 189, numInferenceSteps: 35, guidanceScale: 6, fps: 24 });
    expect(settings.seed).toBeNull();
    expect(settings.flowShift).toBeNull();
  });
  it("enforces tier frame caps with any integer (no cadence)", () => {
    expect(validateCosmosSettings({ numFrames: 190 }).numFrames).toBe(190);
    expect(() => validateCosmosSettings({ numFrames: 24 })).toThrowError(/num_frames/);
    expect(() => validateCosmosSettings({ resolution: "720_16_9", numFrames: 198 })).toThrowError(/197/);
    expect(validateCosmosSettings({ resolution: "480_16_9", numFrames: 297 }).numFrames).toBe(297);
    expect(() => validateCosmosSettings({ numInferenceSteps: 0 })).toThrowError(/num_inference_steps/);
    expect(() => validateCosmosSettings({ guidanceScale: 9 })).toThrowError(/Guidance/);
    expect(() => validateCosmosSettings({ fps: 120 })).toThrowError(/FPS/);
    expect(() => validateCosmosSettings({ seed: -1 })).toThrowError(/Seed/);
  });
  it("passes explicit seed and flow shift, nulls empty seed", () => {
    expect(validateCosmosSettings({ seed: 42 }).seed).toBe(42);
    expect(validateCosmosSettings({ flowShift: 12 }).flowShift).toBe(12);
  });
});

describe("validateMotionRequest", () => {
  it("accepts all three documented modes", () => {
    const png = mp4Bytes(64);
    expect(() => validateMotionRequest(baseRequest())).not.toThrow();
    expect(() => validateMotionRequest(baseRequest({ mode: "image2video", inputBytes: png, inputMime: "image/png" }))).not.toThrow();
    expect(() => validateMotionRequest(baseRequest({ mode: "video2video", inputBytes: png, inputMime: "video/mp4" }))).not.toThrow();
  });
  it("requires a prompt and correctly-typed conditioning", () => {
    expect(() => validateMotionRequest(baseRequest({ prompt: "  " }))).toThrowError(/prompt/);
    expect(() => validateMotionRequest(baseRequest({ mode: "image2video" }))).toThrowError(/source image/);
    expect(() => validateMotionRequest(baseRequest({ mode: "video2video" }))).toThrowError(/source video/);
    expect(() =>
      validateMotionRequest(baseRequest({ mode: "image2video", inputBytes: mp4Bytes(64), inputMime: "video/mp4" }))
    ).toThrowError(/image source/);
  });
  it("rejects unknown providers, models, and modes", () => {
    expect(() => validateMotionRequest(baseRequest({ provider: "other" }))).toThrowError(/provider/);
    expect(() => validateMotionRequest(baseRequest({ model: "other/model" }))).toThrowError(/model/);
    expect(() => validateMotionRequest(baseRequest({ mode: "audio2video" as never }))).toThrowError(/Unsupported mode/);
  });
});

describe("buildCosmosRequestBody", () => {
  it("emits the documented hosted fields, byte-comparable with the Playground", () => {
    const settings = validateCosmosSettings({ resolution: "480_16_9", numFrames: 25, seed: 42 });
    const body = buildCosmosRequestBody({ mode: "text2video", prompt: "p", settings });
    expect(Object.keys(body).sort()).toEqual(["fps", "guidance_scale", "model_mode", "negative_prompt", "num_frames", "num_inference_steps", "prompt", "resolution", "seed"]);
    expect(body).toMatchObject({
      model_mode: "text2video",
      prompt: "p",
      negative_prompt: "",
      seed: 42,
      guidance_scale: 6,
      num_inference_steps: 35,
      num_frames: 25,
      resolution: "480_16_9",
      fps: 24
    });
    expect("image" in body).toBe(false);
    expect("input_reference" in body).toBe(false);
  });
  it("matches the documented text2video example shape", () => {
    const settings = validateCosmosSettings({ resolution: "480_16_9", numFrames: 25, numInferenceSteps: 35, fps: 24, seed: 42 });
    const body = buildCosmosRequestBody({
      mode: "text2video",
      prompt: "A premium black and silver futuristic technology object floating in a dark studio, slow cinematic camera movement, realistic reflections, subtle atmospheric particles",
      settings
    });
    expect(body).toEqual({
      model_mode: "text2video",
      prompt: "A premium black and silver futuristic technology object floating in a dark studio, slow cinematic camera movement, realistic reflections, subtle atmospheric particles",
      negative_prompt: "",
      resolution: "480_16_9",
      num_frames: 25,
      num_inference_steps: 35,
      guidance_scale: 6,
      fps: 24,
      seed: 42
    });
  });
  it("nulls empty seeds and attaches input_reference for conditioned modes", () => {
    const settings = validateCosmosSettings({});
    const text = buildCosmosRequestBody({ mode: "text2video", prompt: "p", settings });
    expect(text.seed).toBeNull();
    const image = buildCosmosRequestBody({ mode: "image2video", prompt: "", inputDataUri: "data:image/png;base64,AAA", settings });
    expect(image.model_mode).toBe("image2video");
    expect(image.input_reference).toBe("data:image/png;base64,AAA");
  });
});

describe("parseCosmosResponse", () => {
  it("decodes a valid b64_video payload", () => {
    const bytes = mp4Bytes();
    const parsed = parseCosmosResponse({ b64_video: bytes.toString("base64"), seed: 7 });
    expect(parsed.videoBytes.equals(bytes)).toBe(true);
    expect(parsed.seed).toBe(7);
  });
  it("rejects missing payloads, error fields, and non-MP4 bytes", () => {
    expect(() => parseCosmosResponse({})).toThrowError(/no video payload/);
    expect(() => parseCosmosResponse({ error: "boom" })).toThrowError(/reported an error/);
    expect(() => parseCosmosResponse({ b64_video: Buffer.from("<html>nope</html>").toString("base64") })).toThrowError(/MP4|small/);
    expect(() => parseCosmosResponse("nope")).toThrowError(/unparseable/);
  });
  it("sniffs the ftyp box", () => {
    expect(isMp4Bytes(mp4Bytes())).toBe(true);
    expect(isMp4Bytes(Buffer.alloc(2048, 1))).toBe(false);
  });
});

describe("executeCosmosGeneration", () => {
  it("refuses without NVIDIA_API_KEY", async () => {
    const error = await executeCosmosGeneration(baseRequest(), { env: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CosmosError);
    expect((error as CosmosError).code).toBe("missing_api_key");
  });
  it("POSTs the documented contract with key auth", async () => {
    const seen: { current: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null } = { current: null };
    const transport: CosmosFetch = async (url, init) => {
      seen.current = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
      return { ok: true, status: 200, json: async () => ({ b64_video: mp4Bytes().toString("base64"), seed: 42 }), text: async () => "" };
    };
    const result = await executeCosmosGeneration(baseRequest({ settings: { seed: 42, numFrames: 25 } }), { env: ENV, transport });
    expect(result.byteLength).toBe(2048);
    expect(result.seed).toBe(42);
    expect(result.frames).toBe(25);
    expect(seen.current?.headers.Authorization).toBe("Bearer test-key");
    expect(seen.current?.url).toBe("https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano");
    expect(seen.current?.body).toMatchObject({ model_mode: "text2video", negative_prompt: "", num_frames: 25, num_inference_steps: 35, guidance_scale: 6, seed: 42 });
  });
  it("honors NVIDIA_COSMOS_ENDPOINT overrides", async () => {
    let url = "";
    await executeCosmosGeneration(baseRequest(), {
      env: { ...ENV, NVIDIA_COSMOS_ENDPOINT: "https://example.test/v1/infer" },
      transport: async (next) => {
        url = next;
        return okTransport({ b64_video: mp4Bytes().toString("base64") })(next, { method: "POST", headers: {}, body: "{}" });
      }
    });
    expect(url).toBe("https://example.test/v1/infer");
  });
  it("maps HTTP failures to user-safe codes", async () => {
    for (const [status, code] of [[401, "unauthorized"], [404, "endpoint_not_found"], [422, "bad_request"], [429, "rate_limited"], [500, "server_error"]] as const) {
      const error = await executeCosmosGeneration(baseRequest(), { env: ENV, transport: statusTransport(status) }).catch((e: unknown) => e);
      expect((error as CosmosError).code).toBe(code);
    }
  });
  it("rejects malformed JSON responses without leaking internals", async () => {
    const transport: CosmosFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
      text: async () => ""
    });
    const error = await executeCosmosGeneration(baseRequest(), { env: ENV, transport }).catch((e: unknown) => e);
    expect((error as CosmosError).code).toBe("malformed_response");
  });
  it("times out a hung endpoint", async () => {
    const hanging: CosmosFetch = () => new Promise(() => {});
    const error = await executeCosmosGeneration(baseRequest(), { env: ENV, transport: hanging, timeoutMs: 50 }).catch((e: unknown) => e);
    expect((error as CosmosError).code).toBe("timeout");
  });
  it("never includes the key in error text", async () => {
    const error = await executeCosmosGeneration(baseRequest(), { env: ENV, transport: statusTransport(500, "secret-check") }).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain("test-key");
    expect((error as CosmosError).detail).not.toContain("test-key");
  });
});

describe("resolveCosmosTimeout", () => {
  it("defaults when the env var is unset or unparseable (regression: NaN instant-fire)", () => {
    expect(resolveCosmosTimeout({}, {})).toBe(COSMOS_DEFAULT_TIMEOUT_MS);
    expect(resolveCosmosTimeout({}, { NVIDIA_COSMOS_TIMEOUT_MS: "not-a-number" })).toBe(COSMOS_DEFAULT_TIMEOUT_MS);
    expect(resolveCosmosTimeout({}, { NVIDIA_COSMOS_TIMEOUT_MS: "" })).toBe(1000); // Number("") is 0 -> 1s floor
  });
  it("honors env and ctx overrides with a 1s floor", () => {
    expect(resolveCosmosTimeout({}, { NVIDIA_COSMOS_TIMEOUT_MS: "120000" })).toBe(120000);
    expect(resolveCosmosTimeout({ timeoutMs: 5000 }, { NVIDIA_COSMOS_TIMEOUT_MS: "120000" })).toBe(5000);
    expect(resolveCosmosTimeout({ timeoutMs: 10 }, {})).toBe(1000);
  });
});

describe("cosmos key resolution + COSMOS_STATUS diagnostic", () => {
  it("prefers the dedicated key, falls back to shared, then missing", () => {
    expect(cosmosApiKey({ NVIDIA_COSMOS_API_KEY: "a", NVIDIA_API_KEY: "b" })).toBe("a");
    expect(cosmosApiKey({ NVIDIA_API_KEY: "b" })).toBe("b");
    expect(cosmosApiKey({})).toBe("");
    expect(cosmosAuthMode({ NVIDIA_COSMOS_API_KEY: "a", NVIDIA_API_KEY: "b" })).toBe("cosmos-key");
    expect(cosmosAuthMode({ NVIDIA_API_KEY: "b" })).toBe("shared-key");
    expect(cosmosAuthMode({})).toBe("missing");
  });
  it("diagnoses endpoint, auth mode, and next action without secrets", () => {
    const missing = diagnoseCosmosConfig({});
    expect(missing.configured).toBe(false);
    expect(missing.authMode).toBe("missing");
    expect(missing.action).toContain("NVIDIA_COSMOS_API_KEY");
    expect(JSON.stringify(missing)).not.toContain("sk-");
    const ready = diagnoseCosmosConfig({ NVIDIA_COSMOS_API_KEY: "sk-cosmos", NVIDIA_COSMOS_ENDPOINT: "https://example.test/v1/infer" });
    expect(ready.configured).toBe(true);
    expect(ready.authMode).toBe("cosmos-key");
    expect(ready.endpoint).toBe("https://example.test/v1/infer");
    expect(ready.action).toContain("404");
    expect(JSON.stringify(ready)).not.toContain("sk-cosmos");
  });
  it("sends the dedicated key when present", async () => {
    let auth = "";
    const transport: CosmosFetch = async (_url, init) => {
      auth = init.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({ b64_video: mp4Bytes().toString("base64") }), text: async () => "" };
    };
    await executeCosmosGeneration(baseRequest(), { env: { NVIDIA_COSMOS_API_KEY: "dedicated", NVIDIA_API_KEY: "shared" }, transport });
    expect(auth).toBe("Bearer dedicated");
  });
});

describe("selectedMotionProviderId", () => {
  it("defaults to cosmos and accepts mock", () => {
    expect(selectedMotionProviderId({})).toBe("nvidia");
    expect(selectedMotionProviderId({ MOTION_PROVIDER: "mock" })).toBe("mock");
    expect(selectedMotionProviderId({ MOTION_PROVIDER: "nvidia" })).toBe("nvidia");
    expect(() => selectedMotionProviderId({ MOTION_PROVIDER: "nope" })).toThrowError(/MOTION_PROVIDER/);
  });
});
