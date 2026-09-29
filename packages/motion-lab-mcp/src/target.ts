/**
 * Target awareness — the MCP server inspects the real project so the AI
 * never has to guess what elements exist.
 *
 * Scans a project root for source files, finds @waves/motion usages,
 * extracts selectors/ids/classes from markup, surfaces data-lab hooks,
 * and cross-references the current Lab ops. Pure filesystem reads —
 * no build, no DOM required.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface TargetUsage {
  file: string;
  kind: "engine-import" | "animate" | "preset" | "timeline" | "scroll" | "stagger" | "spring" | "selector";
  detail: string;
  line: number;
}

export interface TargetReport {
  root: string;
  filesScanned: number;
  sourceFiles: string[];
  motionUsages: TargetUsage[];
  selectors: string[];
  hooks: string[];
  opTargets: string[];
  unmatchedOpTargets: string[];
  notes: string[];
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".html", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".motion", "coverage", ".turbo", ".vite", "public"]);

function walk(dir: string, out: string[], depth: number): void {
  if (depth > 6) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out, depth + 1);
    else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
}

const USAGE_PATTERNS: Array<{ kind: TargetUsage["kind"]; pattern: RegExp }> = [
  { kind: "engine-import", pattern: /@waves\/motion/ },
  { kind: "animate", pattern: /\.(animate|update)\s*\(/ },
  { kind: "preset", pattern: /\b(runPreset|getPreset|listPresets|PRESETS)\b/ },
  { kind: "timeline", pattern: /\b(createTimeline|new Timeline|MotionNode|motion\s*\()/ },
  { kind: "scroll", pattern: /\b(createScroll|ScrollController)\b/ },
  { kind: "stagger", pattern: /\b(stagger|Stagger|resolveStaggerOrder|configureStagger)\b/ },
  { kind: "spring", pattern: /\b(spring|Spring|waves-spring)\b/ }
];

function extractSelectors(line: string): string[] {
  const found: string[] = [];
  const quoted = line.matchAll(/["']([#.])([A-Za-z][\w-]*)["']/g);
  for (const match of quoted) found.push(`${match[1]}${match[2]}`);
  const ids = line.matchAll(/\bid\s*=\s*["']([A-Za-z][\w-]*)["']/g);
  for (const match of ids) found.push(`#${match[1]}`);
  const classes = line.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']+)["']/g);
  for (const match of classes) {
    for (const token of match[1].split(/\s+/)) {
      if (/^[A-Za-z][\w-]*$/.test(token)) found.push(`.${token}`);
    }
  }
  return [...new Set(found)];
}

export function inspectTarget(root: string, opTargets: string[]): TargetReport {
  const files: string[] = [];
  walk(root, files, 0);
  const usages: TargetUsage[] = [];
  const selectorSet = new Set<string>();
  const hookSet = new Set<string>();
  const notes: string[] = [];

  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.length > 400_000) {
      notes.push(`Skipped oversized file: ${relative(root, file)}`);
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const { kind, pattern } of USAGE_PATTERNS) {
        if (pattern.test(line)) {
          usages.push({ file: relative(root, file), kind, detail: line.trim().slice(0, 160), line: index + 1 });
          break;
        }
      }
      for (const selector of extractSelectors(line)) selectorSet.add(selector);
      for (const match of line.matchAll(/data-lab\s*=\s*["']([^"']+)["']/g)) hookSet.add(match[1]);
    });
  }

  const selectors = [...selectorSet].sort().slice(0, 200);
  const unmatched = opTargets.filter((target) => {
    if (target === "*" || target.trim().length === 0) return false;
    if (target.startsWith("#lab-scene-") || target.startsWith("#lab-")) return false;
    const first = target.split(/[\s,>+[~:]/)[0];
    if (first.startsWith("#") || first.startsWith(".")) return !selectorSet.has(first);
    return false;
  });

  if (files.length === 0) notes.push("No source files found under the target root.");
  if (usages.length === 0) notes.push("No @waves/motion usage detected — greenfield target.");

  return {
    root,
    filesScanned: files.length,
    sourceFiles: files.map((file) => relative(root, file)).sort().slice(0, 120),
    motionUsages: usages.slice(0, 120),
    selectors,
    hooks: [...hookSet].sort(),
    opTargets,
    unmatchedOpTargets: [...new Set(unmatched)],
    notes
  };
}
