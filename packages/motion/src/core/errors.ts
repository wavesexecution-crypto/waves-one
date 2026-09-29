/**
 * Waves Motion Engine — errors, diagnostics and dev warnings.
 *
 * Errors carry stable machine-readable codes so OpenCode can branch on them
 * instead of pattern-matching messages.
 */

export type MotionErrorCode =
  | "MOTION_TARGET_NOT_FOUND"
  | "MOTION_TARGET_INVALID"
  | "MOTION_UNKNOWN_PROPERTY"
  | "MOTION_INVALID_VALUE"
  | "MOTION_UNKNOWN_PRESET"
  | "MOTION_UNKNOWN_EASING"
  | "MOTION_UNKNOWN_STAGGER_ORIGIN"
  | "MOTION_INVALID_SPEC"
  | "MOTION_NO_DOM"
  | "MOTION_CYCLE_DETECTED"
  | "MOTION_REDUCED_MOTION"
  | "MOTION_PERFORMANCE";

export class WavesMotionError extends Error {
  readonly code: MotionErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: MotionErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "WavesMotionError";
    this.code = code;
    if (details) this.details = details;
  }
}

export interface MotionDiagnostic {
  code: MotionErrorCode;
  message: string;
  details?: Record<string, unknown>;
  at: number;
}

const diagnostics: MotionDiagnostic[] = [];
let diagnosticLimit = 200;

/** Record a non-fatal diagnostic for the inspector / CLI. */
export function reportDiagnostic(code: MotionErrorCode, message: string, details?: Record<string, unknown>): MotionDiagnostic {
  const entry: MotionDiagnostic = { code, message, details, at: Date.now() };
  diagnostics.push(entry);
  if (diagnostics.length > diagnosticLimit) diagnostics.shift();
  return entry;
}

export function getDiagnostics(): readonly MotionDiagnostic[] {
  return diagnostics;
}

export function clearDiagnostics(): void {
  diagnostics.length = 0;
}

export function setDiagnosticLimit(limit: number): void {
  diagnosticLimit = Math.max(1, limit);
  while (diagnostics.length > diagnosticLimit) diagnostics.shift();
}

/** Emit a warning once per key so repeated frames don't flood the console. */
const warned = new Set<string>();

export function devWarn(warnKey: string, ...args: unknown[]): void {
  if (warned.has(warnKey)) return;
  warned.add(warnKey);
  if (typeof console !== "undefined" && console.warn) console.warn("[waves-motion]", ...args);
}

export function resetWarnings(): void {
  warned.clear();
}

/** Throw a typed error. */
export function fail(code: MotionErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new WavesMotionError(code, message, details);
}

/** Assert a condition, throwing a typed error when it fails. */
export function assertMotion(condition: unknown, code: MotionErrorCode, message: string, details?: Record<string, unknown>): void {
  if (!condition) fail(code, message, details);
}

/**
 * Reduce an unknown thrown value to a stable, serialisable shape so the
 * inspector and CLI can always render *something* useful.
 */
export function describeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof WavesMotionError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}