/**
 * DOM access layer.
 *
 * Every DOM read/write the engine performs goes through this module so that:
 *  - the engine can be imported in Node (CLI, tests, SSR) without a DOM,
 *  - reads are batched (one `getComputedStyle` per element per build, never
 *    per frame),
 *  - target resolution is consistent and inspectable.
 */

import type { TargetInput } from "../types";
import { fail, reportDiagnostic } from "./errors";

export function hasDOM(): boolean {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

export function isElement(value: unknown): value is Element {
  return Boolean(value) && typeof value === "object" && (value as Element).nodeType === 1;
}

export function isSVGElement(value: Element): boolean {
  const ns = (value as unknown as { namespaceURI?: string | null }).namespaceURI;
  return Boolean(ns && ns.includes("svg")) || typeof (value as any).ownerSVGElement !== "undefined";
}

export interface ResolvedTargets {
  elements: Element[];
  /** Selectors that matched nothing — surfaced as diagnostics, never silent. */
  missing: string[];
}

function isNodeList(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && typeof (value as NodeList).length === "number";
}

/**
 * Resolve any target input into a unique element list.
 * Order is preserved because it defines the stagger order.
 */
export function resolveTargets(target: TargetInput, root?: ParentNode | null): ResolvedTargets {
  const elements: Element[] = [];
  const missing: string[] = [];

  const push = (element: Element | null | undefined) => {
    if (element && isElement(element) && !elements.includes(element)) elements.push(element);
  };

  if (!target) return { elements, missing };

  if (typeof target === "string") {
    if (!hasDOM()) {
      fail("MOTION_NO_DOM", `Cannot resolve selector "${target}" — no DOM available in this environment.`, { selector: target });
    }
    const scope: ParentNode = (root as ParentNode) ?? document;
    try {
      if (target === "window" || target === "document" || target === "self") {
        if (target === "self" && isElement(root)) push(root as Element);
        return { elements, missing };
      }
      const found = scope.querySelectorAll(target);
      if (found.length === 0) missing.push(target);
      found.forEach((element) => push(element));
    } catch (error) {
      fail("MOTION_TARGET_INVALID", `Invalid selector "${target}"`, { selector: target, error: String(error) });
    }
    return { elements, missing };
  }

  if (isElement(target)) {
    push(target);
    return { elements, missing };
  }

  if (isNodeList(target) || Array.isArray(target)) {
    for (const item of Array.from(target as ArrayLike<unknown>)) {
      if (isElement(item)) push(item);
    }
    return { elements, missing };
  }

  fail("MOTION_TARGET_INVALID", "Unsupported target. Use a selector, an Element, or a list of Elements.", { target: String(target) });
}

/** Resolve targets and report missing selectors as diagnostics + console warnings. */
export function requireTargets(quiet: boolean, target: TargetInput, root?: ParentNode | null): Element[] {
  const { elements, missing } = resolveTargets(target, root);
  for (const selector of missing) {
    reportDiagnostic("MOTION_TARGET_NOT_FOUND", `No element matched selector "${selector}".`, { selector });
    if (!quiet && typeof console !== "undefined" && console.warn) {
      console.warn(`[waves-motion] no element matched selector "${selector}" — animation skipped`);
    }
  }
  return elements;
}

/** Compact, stable element description for snapshots, logs and assertions. */
export function describeTarget(element: Element | null | undefined): string {
  if (!element) return "(none)";
  if (!isElement(element)) return String(element);
  const tag = element.tagName ? element.tagName.toLowerCase() : "element";
  const id = element.id ? `#${element.id}` : "";
  const classes = (element.getAttribute && element.getAttribute("class")) || "";
  const classList = classes
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join("");
  return `${tag}${id}${classList}` || tag;
}

export function toCamel(property: string): string {
  return property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

export function toKebab(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
/**
 * Batch-read computed style values for one element.
 * One `getComputedStyle` call regardless of how many properties we need.
 */
export function readComputed(element: Element, properties: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!hasDOM() || typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    for (const property of properties) result[property] = "";
    return result;
  }
  const computed = window.getComputedStyle(element as HTMLElement);
  for (const property of properties) {
    const value = computed.getPropertyValue(property) || (computed as any)[toCamel(property)] || "";
    result[property] = typeof value === "string" ? value : String(value ?? "");
  }
  return result;
}

/** Numeric read with a fallback for environments that report nothing (jsdom). */
export function readNumeric(computed: Record<string, string>, property: string, fallback: number): number {
  const raw = computed[property];
  if (!raw || raw === "auto" || raw === "none" || raw === "normal") return fallback;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export function getRect(element: Element): RectLike {
  if (typeof (element as HTMLElement).getBoundingClientRect !== "function") {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
  const rect = (element as HTMLElement).getBoundingClientRect();
  return {
    x: rect.x ?? rect.left,
    y: rect.y ?? rect.top,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom
  };
}

export function getViewport(): { width: number; height: number; scrollY: number; scrollX: number } {
  if (typeof window === "undefined") return { width: 0, height: 0, scrollY: 0, scrollX: 0 };
  return {
    width: window.innerWidth || document.documentElement?.clientWidth || 0,
    height: window.innerHeight || document.documentElement?.clientHeight || 0,
    scrollY: window.scrollY || window.pageYOffset || 0,
    scrollX: window.scrollX || window.pageXOffset || 0
  };
}

let idCounter = 0;

/** Monotonic engine id, e.g. `waves-12`. */
export function nextId(prefix = "waves"): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Reset the id counter (tests only — keeps snapshot ids stable). */
export function resetIdCounter(value = 0): void {
  idCounter = value;
}

/** Shared event-target helper — used by scroll, gesture and layout modules. */
export function onEvent(
  target: EventTarget,
  type: string,
  handler: (event: any) => void,
  options?: AddEventListenerOptions | boolean
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}

/** rAF-free microtask flush used when a seek must be visible immediately. */
export function microtask(callback: () => void): void {
  if (typeof queueMicrotask === "function") queueMicrotask(callback);
  else void Promise.resolve().then(callback);
}