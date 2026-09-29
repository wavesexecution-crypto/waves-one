import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Plugin } from "vite";
import { closeDb, openDb } from "../../packages/motion-lab-mcp/src/db.js";
import {
  deleteGeneration,
  generateAndWait,
  getGeneration,
  listGenerations,
  markSelected,
  motionProviderStatus,
  saveGenerationToLab,
  saveSourceImage,
  type GenerateInput
} from "../../packages/motion-lab-mcp/src/ai-motion.js";
import { CosmosError, diagnoseCosmosConfig } from "../../packages/motion-lab-mcp/src/cosmos.js";
import { enhanceMotionPrompt, liveChatStatus } from "../../packages/motion-lab-mcp/src/nvidia-live.js";
import { getAsset } from "../../packages/motion-lab-mcp/src/assets.js";

const UPLOAD_BYTES_MAX = 30_000_000;
const JSON_BYTES_MAX = 512_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > cap) {
        reject(new Error(`Request body exceeds the ${(cap / 1_000_000).toFixed(0)} MB limit.`));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function safeError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof CosmosError) {
    const clientCodes = new Set(["invalid_input", "unsupported_mode", "missing_api_key"]);
    return {
      status: error.code === "missing_api_key" ? 503 : clientCodes.has(error.code) ? 400 : 502,
      code: error.code,
      message: error.message
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, code: "server_error", message: message.slice(0, 300) };
}

/**
 * AI Motion bridge — dev-only server routes. Every NVIDIA credential stays
 * in this process: the browser only ever sees job metadata and video URLs.
 * No route returns keys, headers, request bodies, or base64 video.
 */
export function aiMotionBridge(workspaceRoot: string): Plugin {
  const labDir = join(workspaceRoot, "apps", "motion-lab");
  return {
    name: "motion-lab-ai-motion",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__lab/ai-motion", (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const path = url.pathname.replace(/\/+$/, "") || "/";
          const method = (req.method ?? "GET").toUpperCase();

          if (method === "GET" && path === "/status") {
            send(res, 200, { ok: true, ...motionProviderStatus(process.env), cosmosConfig: diagnoseCosmosConfig(process.env), promptEnhancement: liveChatStatus(process.env) });
            return;
          }

          if (method === "POST" && path === "/enhance") {
            const raw = await readBody(req, JSON_BYTES_MAX);
            const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
            const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
            if (!prompt.trim()) {
              send(res, 400, { ok: false, code: "invalid_input", error: "Enhancement needs a prompt." });
              return;
            }
            const mode = parsed.mode === "image2video" ? "image2video" : "text2video";
            let imageBytes: Buffer | undefined;
            let imageMime: string | undefined;
            if (typeof parsed.sourceId === "string" && parsed.sourceId) {
              const db = await openDb(labDir);
              try {
                const asset = getAsset(db.raw, parsed.sourceId);
                if (!asset?.path) throw new Error(`Unknown source "${parsed.sourceId}".`);
                const resolved = join(labDir, asset.path);
                if (!resolved.startsWith(labDir)) throw new Error("Source escapes the lab directory.");
                imageBytes = readFileSync(resolved);
                const meta = asset.meta as Record<string, unknown>;
                imageMime = typeof meta.mime === "string" ? meta.mime : "image/png";
              } finally {
                closeDb(db);
              }
            }
            const result = await enhanceMotionPrompt(
              { prompt, mode, ...(imageBytes ? { imageBytes, imageMime } : {}) },
              { env: process.env }
            );
            send(res, 200, { ok: true, ...result });
            return;
          }

          if (method === "POST" && path === "/upload") {
            const raw = await readBody(req, UPLOAD_BYTES_MAX);
            const parsed = JSON.parse(raw || "{}") as { name?: unknown; dataUrl?: unknown; label?: unknown; projectId?: unknown };
            if (typeof parsed.dataUrl !== "string" || !parsed.dataUrl) {
              send(res, 400, { ok: false, code: "invalid_input", error: "Upload needs { name, dataUrl }." });
              return;
            }
            const projectId = typeof parsed.projectId === "string" && parsed.projectId ? parsed.projectId : "project_default";
            const db = await openDb(labDir);
            try {
              const source = saveSourceImage(db.raw, labDir, projectId, {
                name: typeof parsed.name === "string" ? parsed.name : "source.png",
                dataUrl: parsed.dataUrl,
                ...(typeof parsed.label === "string" ? { label: parsed.label } : {})
              });
              send(res, 200, { ok: true, source });
            } finally {
              closeDb(db);
            }
            return;
          }

          if (method === "POST" && path === "/generate") {
            // Generations run minutes on the trial endpoint — never let the
            // socket die first. Client shows elapsed time, never fake %.
            try {
              (req as unknown as { setTimeout?: (ms: number) => void }).setTimeout?.(0);
            } catch {
              /* best-effort */
            }
            const raw = await readBody(req, JSON_BYTES_MAX);
            const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
            const mode = parsed.mode;
            if (mode !== "image2video" && mode !== "text2video" && mode !== "video2video") {
              send(res, 400, {
                ok: false,
                code: "unsupported_mode",
                error: `Unsupported mode "${String(mode)}". Use text2video, image2video, or video2video.`
              });
              return;
            }
            const settings = parsed.settings !== null && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
              ? (parsed.settings as GenerateInput["settings"])
              : undefined;
            const input: GenerateInput = {
              mode,
              prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
              ...(typeof parsed.negativePrompt === "string" ? { negativePrompt: parsed.negativePrompt } : {}),
              ...(settings ? { settings } : {}),
              ...(typeof parsed.sourceId === "string" ? { sourceId: parsed.sourceId } : {}),
              projectId: typeof parsed.projectId === "string" && parsed.projectId ? parsed.projectId : "project_default"
            };
            // Runtime provider switch (model selector). Server env
            // MOTION_PROVIDER stays the default; this overrides per call.
            const providerOverride = parsed.provider === "mock" || parsed.provider === "cosmos" ? String(parsed.provider) : undefined;
            const env = providerOverride ? { ...process.env, MOTION_PROVIDER: providerOverride } : process.env;
            const db = await openDb(labDir);
            try {
              const result = await generateAndWait(labDir, input, { db: db.raw, env });
              send(res, result.status === "COMPLETED" ? 200 : 502, { ok: result.status === "COMPLETED", ...result });
            } finally {
              closeDb(db);
            }
            return;
          }

          if (method === "GET" && (path === "/generations" || path === "/generations/")) {
            const projectId = url.searchParams.get("projectId") || "project_default";
            const limit = Math.max(1, Math.min(200, Math.round(Number(url.searchParams.get("limit")) || 50)));
            const db = await openDb(labDir);
            try {
              send(res, 200, { ok: true, generations: listGenerations(db.raw, projectId, limit) });
            } finally {
              closeDb(db);
            }
            return;
          }

          const idMatch = /^\/generations\/([^/]+)(\/(use|save))?$/.exec(path);
          if (idMatch) {
            const id = decodeURIComponent(idMatch[1]);
            const verb = idMatch[3];
            const db = await openDb(labDir);
            try {
              if (method === "GET" && !verb) {
                const generation = getGeneration(db.raw, id);
                if (!generation) {
                  send(res, 404, { ok: false, code: "not_found", error: `Unknown generation "${id}".` });
                  return;
                }
                send(res, 200, { ok: true, generation });
                return;
              }
              if (method === "DELETE" && !verb) {
                send(res, 200, { ok: deleteGeneration(db.raw, labDir, id), generationId: id });
                return;
              }
              if (method === "POST" && verb === "use") {
                send(res, 200, { ok: true, generation: markSelected(db.raw, id) });
                return;
              }
              if (method === "POST" && verb === "save") {
                send(res, 200, { ok: true, generation: saveGenerationToLab(db.raw, labDir, id) });
                return;
              }
              send(res, 405, { ok: false, code: "method_not_allowed", error: "POST only." });
              return;
            } finally {
              closeDb(db);
            }
          }

          send(res, 404, { ok: false, code: "not_found", error: "Unknown AI Motion route." });
        })().catch((error: unknown) => {
          const mapped = safeError(error);
          try {
            send(res, mapped.status, { ok: false, code: mapped.code, error: mapped.message });
          } catch {
            /* response already gone */
          }
        });
      });
      // Ensure the output directory exists at boot so static serving 404s
      // read as "no generations yet" rather than a missing folder.
      try {
        mkdirSync(join(labDir, "public", "ai-motion", "sources"), { recursive: true });
      } catch {
        /* best-effort */
      }
    }
  };
}
