/**
 * Writer pool — one `StyleWriter` per element, committed once per frame.
 *
 * The pool is the reason the engine stays frame-budget friendly: no matter how
 * many animations touch the same element, there is exactly one style write per
 * element per frame, and `will-change` is released as soon as the element goes
 * idle.
 */

import type { Primitive } from "../types";
import { StyleWriter, type WriteRecord, type WriterHost } from "./writer";
import { getPropertyDefinition, type PropertyDefinition } from "./properties";

export interface DirtyCommitStats {
  writers: number;
  writes: number;
}

export class WriterPool {
  private writers = new Map<Element, StyleWriter>();
  private dirty = new Set<StyleWriter>();
  private writeListeners = new Set<(record: WriteRecord) => void>();

  constructor(private readonly host: WriterHost) {}

  /** Producer of the current time + config values for the writers. */
  get count(): number {
    return this.writers.size;
  }

  writerFor(element: Element): StyleWriter {
    let writer = this.writers.get(element);
    if (!writer) {
      const host = this.host;
      writer = new StyleWriter(element, {
        now: () => host.now(),
        gpuHints: () => host.gpuHints(),
        precision: () => host.precision(),
        onWrite: (record) => host.onWrite(record)
      });
      this.writers.set(element, writer);
    }
    return writer;
  }

  /** Mark a writer as needing a commit this frame. */
  markDirty(writer: StyleWriter): void {
    writer.markDirty();
    this.dirty.add(writer);
  }

  /** Commit every dirty writer. Called exactly once per frame by the engine. */
  commit(): DirtyCommitStats {
    if (this.dirty.size === 0) return { writers: 0, writes: 0 };
    const writers = Array.from(this.dirty);
    this.dirty.clear();
    let writes = 0;
    for (const writer of writers) {
      if (!writer.isDirty) continue;
      const before = writes;
      writer.commit();
      writes = before + 1;
    }
    return { writers: writers.length, writes };
  }

  /** Drop compositor hints for elements that no longer have active animations. */
  releaseIdle(active: Set<Element>): void {
    for (const [element, writer] of this.writers) {
      if (!active.has(element)) writer.releaseHints();
    }
  }

  /** Writer count and dirty count, for the inspector. */
  stats(): { tracked: number; dirty: number } {
    return { tracked: this.writers.size, dirty: this.dirty.size };
  }

  onWrite(listener: (record: WriteRecord) => void): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  notifyWrite(record: WriteRecord): void {
    for (const listener of this.writeListeners) listener(record);
  }

  reset(): void {
    for (const writer of this.writers.values()) writer.reset();
    this.writers.clear();
    this.dirty.clear();
  }
}

/**
 * Resolve the start values for a set of properties in as few DOM reads as
 * possible. This is the only place the engine reads style during a build.
 */
export function resolveBaseValues(writer: StyleWriter, properties: PropertyDefinition[]): Map<string, Primitive> {
  const bases = new Map<string, Primitive>();
  for (const definition of properties) {
    bases.set(definition.name, writer.readBase(definition.name));
  }
  return bases;
}

/** Resolve start values when only names are known (declarative specs). */
export function resolveBaseValuesByName(writer: StyleWriter, names: string[]): Map<string, Primitive> {
  const bases = new Map<string, Primitive>();
  for (const name of names) {
    const definition = getPropertyDefinition(name);
    bases.set(name, definition ? writer.readBase(name) : writer.readBase(name));
  }
  return bases;
}