/**
 * Voiceover engine — formalized voiceover artifact management.
 *
 * Owns registration, metadata, listing, and retrieval for voiceover audio
 * under `.motion/voiceovers/` (the same directory the upload middleware
 * and the transcribe/detect tools already use — this service wraps that
 * layout, it does not move it). Transcription stays key-gated in the
 * transcribe_voiceover tool; beat detection stays in detect_beats.
 * No audio bytes are ever logged or transmitted except to an explicitly
 * configured provider for the requested operation.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const VOICEOVER_EXTENSIONS = ["mp3", "wav", "m4a", "aac"];
export const VOICEOVER_BYTES_MAX = 50_000_000;

export interface VoiceoverRecord {
  id: string;
  file: string;
  mime: string;
  bytes: number;
  durationMs: number;
  createdAt: string;
}

export interface VoiceoverRow {
  id: string;
  project_id: string;
  file: string;
  mime: string;
  bytes: number;
  duration_ms: number;
  created_at: number;
}

function voiceoverDir(labDir: string): string {
  const dir = join(labDir, ".motion", "voiceovers");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mimeForExtension(ext: string): string {
  if (ext === "wav") return "audio/wav";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "aac") return "audio/aac";
  return "audio/mpeg";
}

/**
 * Register voiceover bytes (upload path). Validates type + size, persists
 * audio + sidecar. Never logs or transmits the bytes.
 */
export function registerVoiceover(
  labDir: string,
  name: string,
  audio: Buffer,
  durationMs: number
): VoiceoverRecord {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (!VOICEOVER_EXTENSIONS.includes(ext)) {
    throw new Error("Voiceover must be MP3, WAV, M4A, or AAC.");
  }
  if (audio.length === 0 || audio.length > VOICEOVER_BYTES_MAX) {
    throw new Error("Voiceover must be non-empty and under 50MB.");
  }
  const dir = voiceoverDir(labDir);
  const id = `vo-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
  writeFileSync(join(dir, `${id}.${ext}`), audio);
  const record: VoiceoverRecord = {
    id,
    file: `${id}.${ext}`,
    mime: mimeForExtension(ext),
    bytes: audio.length,
    durationMs: durationMs > 0 ? Math.round(durationMs) : 0,
    createdAt: new Date().toISOString()
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...record, audio: `voiceovers/${id}.${ext}` }, null, 2));
  return record;
}

/** List registered voiceovers (metadata only, never bytes). */
export function listVoiceovers(labDir: string): VoiceoverRecord[] {
  const dir = voiceoverDir(labDir);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: VoiceoverRecord[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
      if (typeof parsed.id !== "string") continue;
      // Canonical sidecars carry `file`; older dev-server sidecars only have
      // `audio: voiceovers/<file>`, so derive the filename from it.
      const audioRef = typeof parsed.audio === "string" ? parsed.audio.replace(/\\/g, "/") : null;
      const fallbackFile = audioRef && audioRef.split("/").pop() ? String(audioRef.split("/").pop()) : `${parsed.id}.mp3`;
      out.push({
        id: parsed.id,
        file: typeof parsed.file === "string" ? parsed.file : fallbackFile,
        mime: typeof parsed.mime === "string" ? parsed.mime : "audio/mpeg",
        bytes: typeof parsed.bytes === "number" ? parsed.bytes : 0,
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
      });
    } catch {
      /* one unreadable sidecar never breaks the listing */
    }
  }
  return out;
}

/** Read voiceover bytes for a provider call or local decode. */
export function readVoiceoverAudio(labDir: string, id: string): { record: VoiceoverRecord; audio: Buffer } {
  const clean = id.replace(/\.mp3$/, "").replace(/\.(wav|m4a|aac)$/, "");
  const record = listVoiceovers(labDir).find((entry) => entry.id === clean);
  if (!record) throw new Error(`Unknown voiceover "${id}". Upload one first.`);
  return { record, audio: readFileSync(join(voiceoverDir(labDir), record.file)) };
}

/** Byte size of a voiceover without loading it (for guards). */
export function voiceoverSize(labDir: string, file: string): number {
  try {
    return statSync(join(voiceoverDir(labDir), file)).size;
  } catch {
    return -1;
  }
}
