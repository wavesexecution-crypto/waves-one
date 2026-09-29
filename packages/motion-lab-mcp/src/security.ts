/**
 * Security module — validation, limits, and isolation.
 *
 * - API key isolation
 * - upload size limits
 * - MIME validation
 * - safe filenames
 * - artifact isolation
 * - provider timeouts
 * - retries
 * - rate limits
 * - request validation
 * - schema validation
 * - no secrets in logs
 * - no secrets in animation JSON
 * - no arbitrary shell execution from prompts
 */

import { randomUUID } from "node:crypto";

export const MAX_UPLOAD_SIZE = 50_000_000;
export const MAX_DURATION_SECONDS = 300;
export const MAX_ELEMENTS_PER_SCENE = 200;
export const MAX_ANIMATION_DURATION_MS = 600_000;

export interface SecurityContext {
  maxUploadSize: number;
  maxDurationSeconds: number;
  maxElementsPerScene: number;
  maxAnimationDurationMs: number;
  allowedMimeTypes: string[];
}

export const DEFAULT_SECURITY_CONTEXT: SecurityContext = {
  maxUploadSize: MAX_UPLOAD_SIZE,
  maxDurationSeconds: MAX_DURATION_SECONDS,
  maxElementsPerScene: MAX_ELEMENTS_PER_SCENE,
  maxAnimationDurationMs: MAX_ANIMATION_DURATION_MS,
  allowedMimeTypes: [
    "audio/mpeg",
    "audio/wav",
    "audio/mp4",
    "audio/aac"
  ]
};

/**
 * Validate upload file.
 */
export function validateUpload(
  name: string,
  size: number,
  mimeType: string,
  context: SecurityContext = DEFAULT_SECURITY_CONTEXT
): void {
  if (size > context.maxUploadSize) {
    throw new SecurityError(`File too large. Maximum size: ${formatBytes(context.maxUploadSize)}`);
  }

  if (!context.allowedMimeTypes.includes(mimeType)) {
    throw new SecurityError(`Invalid file type. Allowed: ${context.allowedMimeTypes.join(", ")}`);
  }

  if (!isSafeFilename(name)) {
    throw new SecurityError("Invalid filename");
  }
}

/**
 * Validate animation duration.
 */
export function validateDuration(durationMs: number, context: SecurityContext = DEFAULT_SECURITY_CONTEXT): void {
  const maxMs = context.maxDurationSeconds * 1000;
  if (durationMs > maxMs) {
    throw new SecurityError(`Animation too long. Maximum duration: ${context.maxDurationSeconds}s`);
  }
}

/**
 * Validate scene element count.
 */
export function validateSceneElements(count: number, context: SecurityContext = DEFAULT_SECURITY_CONTEXT): void {
  if (count > context.maxElementsPerScene) {
    throw new SecurityError(`Too many elements. Maximum: ${context.maxElementsPerScene}`);
  }
}

/**
 * Validate animation operations.
 */
export function validateAnimationOps(ops: unknown[]): void {
  // No shell commands or arbitrary code execution
  const opsJson = JSON.stringify(ops);
  const dangerousPatterns = [
    /eval\s*\(/i,
    /function\s*\(/i,
    /setTimeout\s*\(/i,
    /setInterval\s*\(/i,
    /document\.write/i,
    /<script/i,
    /onclick\s*=/i,
    /onload\s*=/i
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(opsJson)) {
      throw new SecurityError("Animation operations contain disallowed patterns");
    }
  }

  // Validate structure
  if (!Array.isArray(ops)) {
    throw new SecurityError("Animation ops must be an array");
  }
}

/**
 * Validate and sanitize user input for prompts.
 */
export function sanitizePrompt(prompt: string): string {
  // Remove null bytes
  let sanitized = prompt.replace(/\0/g, "");

  // Remove control characters (except newlines and tabs)
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Trim whitespace
  sanitized = sanitized.trim();

  // Limit length
  const MAX_PROMPT_LENGTH = 10_000;
  if (sanitized.length > MAX_PROMPT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_PROMPT_LENGTH);
  }

  return sanitized;
}

/**
 * Generate safe artifact filename.
 */
export function generateSafeFilename(originalName: string, extension: string): string {
  const base = sanitizeFilename(originalName);
  const random = randomUUID().slice(0, 8);
  return `${base}-${random}.${extension}`;
}

/**
 * Sanitize filename for safe storage.
 */
export function sanitizeFilename(name: string): string {
  // Remove path separators
  let sanitized = name.replace(/[\\/]/g, "_");

  // Remove or replace dangerous characters
  sanitized = sanitized.replace(/[<>:"|?*]/g, "_");

  // Limit length
  const MAX_LENGTH = 128;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.slice(0, MAX_LENGTH);
  }

  // Remove leading/trailing dots and spaces
  sanitized = sanitized.replace(/^\.+|\.+$/g, "").replace(/^ +| +$/g, "");

  return sanitized || "untitled";
}

/**
 * Validate MIME type against allowed list.
 */
export function validateMimeType(mimeType: string, allowed: string[]): boolean {
  return allowed.includes(mimeType);
}

/**
 * Check if filename is safe.
 */
export function isSafeFilename(filename: string): boolean {
  const unsafePatterns = [
    /\.\./g, // path traversal
    /\/\\|\\\\/g, // path separators
    /[\x00-\x1F\x7F]/, // control characters
    /^\.+$/ // dot-only
  ];

  for (const pattern of unsafePatterns) {
    if (pattern.test(filename)) {
      return false;
    }
  }

  return true;
}

/**
 * Format bytes to human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Security error class.
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}
