/**
 * Motion state store — the single source of truth the browser replays.
 *
 * Internal state lives at `<lab>/.motion/state.json` (full op log with
 * revision). The browser-facing mirror lives at
 * `<lab>/public/motion-state.json` (`{ revision, updatedAt, ops }`), which
 * the runtime surface polls. Every mutation bumps the revision, writes both
 * files atomically, and appends to `.motion/history.jsonl`.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyState, type MotionOp, type MotionState } from "./ops.js";

let counter = 0;

export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export interface StorePaths {
  root: string;
  labDir: string;
  internalFile: string;
  publicFile: string;
  historyFile: string;
}

/** Locate the workspace root (walk up to pnpm-workspace.yaml) then the lab. */
export function resolvePaths(startDir: string): StorePaths {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    try {
      readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
      break;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const override = process.env.MOTION_LAB_ROOT?.trim();
  const root = override && override.length > 0 ? override : dir;
  const labDir = join(root, "apps", "motion-lab");
  return {
    root,
    labDir,
    internalFile: join(labDir, ".motion", "state.json"),
    publicFile: join(labDir, "public", "motion-state.json"),
    historyFile: join(labDir, ".motion", "history.jsonl")
  };
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait: keeps stdio framing simple with zero dependencies */
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  // On Windows the dev server can briefly lock the served public mirror;
  // retry the atomic rename, then fall back to a direct write so a
  // publish is never lost to a transient lock.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 4) {
        sleepSync(60);
        continue;
      }
      try {
        writeFileSync(file, text, "utf8");
        try {
          unlinkSync(tmp);
        } catch {
          /* temp cleanup is best-effort */
        }
        return;
      } catch {
        throw error;
      }
    }
  }
}

export function readState(paths: StorePaths): MotionState {
  try {
    const raw = readFileSync(paths.internalFile, "utf8");
    const parsed = JSON.parse(raw) as MotionState;
    if (!Array.isArray(parsed.ops) || typeof parsed.revision !== "number") return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

export function persist(paths: StorePaths, state: MotionState): MotionState {
  const next: MotionState = { ...state, updatedAt: new Date().toISOString() };
  writeAtomic(paths.internalFile, JSON.stringify(next, null, 2));
  writeAtomic(
    paths.publicFile,
    JSON.stringify({ revision: next.revision, updatedAt: next.updatedAt, ops: next.ops }, null, 2)
  );
  try {
    mkdirSync(dirname(paths.historyFile), { recursive: true });
    const line = JSON.stringify({ revision: next.revision, updatedAt: next.updatedAt, ops: next.ops.length }) + "\n";
    writeFileSync(paths.historyFile, line, { flag: "a" });
  } catch {
    /* history is best-effort */
  }
  return next;
}

export function commit(paths: StorePaths, ops: MotionOp[]): MotionState {
  const current = readState(paths);
  return persist(paths, { revision: current.revision + 1, updatedAt: current.updatedAt, ops });
}

export function appendOp(paths: StorePaths, op: MotionOp): { state: MotionState; op: MotionOp } {
  const current = readState(paths);
  const state = persist(paths, {
    revision: current.revision + 1,
    updatedAt: current.updatedAt,
    ops: [...current.ops, op]
  });
  return { state, op };
}

export function findOp(state: MotionState, id: string): MotionOp | undefined {
  return state.ops.find((op) => op.id === id);
}
