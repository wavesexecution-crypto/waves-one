/**
 * Observability — structured logging with distributed tracing support.
 *
 * Every operation has:
 * - request ID
 * - project ID
 * - job ID
 * - provider
 * - model
 * - duration
 * - status
 * - error
 *
 * No random console logging for production operations.
 */

import { randomUUID } from "node:crypto";

export interface LogEntry {
  timestamp: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  requestId: string;
  projectId?: string;
  jobId?: string;
  provider?: string;
  model?: string;
  operation: string;
  durationMs?: number;
  status?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface LoggerContext {
  requestId: string;
  projectId?: string;
  jobId?: string;
  provider?: string;
  model?: string;
}

export class Logger {
  private readonly prefix: string;
  private readonly verbose: boolean;

  constructor(options: { prefix?: string; verbose?: boolean } = {}) {
    this.prefix = options.prefix ?? "motion-lab";
    this.verbose = options.verbose ?? false;
  }

  /**
   * Create child logger with additional context.
   */
  child(_context: Partial<LoggerContext>): Logger {
    return new Logger({
      prefix: this.prefix,
      verbose: this.verbose
    });
  }

  /**
   * Trace level (detailed debugging).
   */
  trace(message: string, metadata?: Record<string, unknown>): void {
    this.log("trace", message, metadata);
  }

  /**
   * Debug level (development debugging).
   */
  debug(message: string, metadata?: Record<string, unknown>): void {
    if (this.verbose) {
      this.log("debug", message, metadata);
    }
  }

  /**
   * Info level (normal operations).
   */
  info(message: string, metadata?: Record<string, unknown>): void {
    this.log("info", message, metadata);
  }

  /**
   * Warn level (non-failure warnings).
   */
  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log("warn", message, metadata);
  }

  /**
   * Error level (operational failures).
   */
  error(message: string, metadata?: Record<string, unknown>): void {
    this.log("error", message, metadata);
  }

  /**
   * Fatal level (system failures).
   */
  fatal(message: string, metadata?: Record<string, unknown>): void {
    this.log("fatal", message, metadata);
  }

  /**
   * Internal log writer.
   */
  private log(level: LogEntry["level"], message: string, metadata?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      requestId: this.context.requestId,
      projectId: this.context.projectId,
      jobId: this.context.jobId,
      operation: message,
      metadata
    };

    // Only include provider/model when explicitly set
    if (this.context.provider) entry.provider = this.context.provider;
    if (this.context.model) entry.model = this.context.model;

    // Write to stderr (stdout reserved for protocol communication)
    const output = JSON.stringify(entry);
    process.stderr.write(`${output}\n`);
  }

  private context: LoggerContext = { requestId: randomUUID() };

  /**
   * Set current request context.
   */
  withContext(context: Partial<LoggerContext>): Logger {
    const logger = this.child(context);
    logger.context = { ...this.context, ...context };
    return logger;
  }

  /**
   * Measure operation duration.
   */
  measure(operation: string, fn: () => Promise<unknown>, metadata?: Record<string, unknown>): Promise<unknown> {
    const startTime = Date.now();
    return fn()
      .then((result) => {
        const duration = Date.now() - startTime;
        this.info(`${operation} completed`, { durationMs: duration, ...metadata });
        return result;
      })
      .catch((error) => {
        const duration = Date.now() - startTime;
        this.error(`${operation} failed`, { durationMs: duration, error: String(error), ...metadata });
        throw error;
      });
  }
}

export const logger = new Logger();
