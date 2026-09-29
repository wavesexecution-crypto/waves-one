/**
 * Style writer.
 *
 * Animations never write inline styles directly. They compute values and hand
 * them to the shared `StyleWriter` for their element; the engine commits every
 * dirty writer exactly once per frame. That guarantees:
 *  1. one write pass per element per frame — no layout thrashing,
 *  2. transform components compose into a single `transform` string, so
 *     concurrent animations on different components merge correctly,
 *  3. filter components compose into a single `filter` string.
 */

import type { Primitive, StyleChannel } from "../types";
import { readComputed, toKebab } from "./dom";
import { composeFilter, composeTransform, decomposeFilter, decomposeTransform, round, type TransformState } from "./values";
import { getPropertyDefinition } from "./properties";

export interface WriteRecord {
  element: Element;
  property: string;
  cssProperty: string;
  channel: StyleChannel;
  value: string;
  time: number;
}

export interface WriterHost {
  now(): number;
  gpuHints(): boolean;
  precision(): number;
  onWrite(record: WriteRecord): void;
}

export class StyleWriter {
  /** Current transform component values for this element. */
  private transform: TransformState = {};
  private filterValue: Record<string, number | string> = {};
  private styleValues = new Map<string, string>();
  private cssVars = new Map<string, string>();
  private svgValues = new Map<string, string>();
  /** Last written value per logical property — the base for the next animation. */
  private lastValues = new Map<string, Primitive>();
  private transformTouched = false;
  private filterTouched = false;
  private dirty = false;
  private transformBaseLoaded = false;
  private filterBaseLoaded = false;
  private hintsApplied = false;

  constructor(
    public readonly element: Element,
    private readonly host: WriterHost
  ) {}

  markDirty(): void {
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Read the value a `to`-only animation should start from. */
  readBase(name: string): Primitive {
    const cached = this.lastValues.get(name);
    if (cached !== undefined) return cached;

    const definition = getPropertyDefinition(name);
    if (!definition) return 0;

    if (definition.channel === "transform") {
      this.loadTransformBase();
      const key = definition.transformKeys?.[0];
      const value = key ? (this.transform[key] as number | undefined) : undefined;
      return value ?? definition.identity;
    }

    if (definition.channel === "filter") {
      this.loadFilterBase();
      const key = definition.filterKey;
      const value = key ? this.filterValue[key] : undefined;
      return (value as Primitive) ?? definition.identity;
    }

    if (definition.channel === "svg") {
      const attribute = definition.cssProperty ?? name;
      const raw = this.element.getAttribute(attribute);
      if (raw !== null && raw !== "") return parseNumericOrString(raw, definition.identity);
      return definition.identity;
    }

    const cssProperty = definition.channel === "cssvar" ? definition.cssProperty ?? name : toKebab(definition.cssProperty ?? name);
    const computed = readComputed(this.element, [cssProperty]);
    const raw = computed[cssProperty];
    if (!raw || raw === "auto" || raw === "normal") return definition.identity;
    return parseNumericOrString(raw, definition.identity);
  }

  private loadTransformBase(): void {
    if (this.transformBaseLoaded) return;
    this.transformBaseLoaded = true;
    const computed = readComputed(this.element, ["transform"]);
    this.transform = { ...decomposeTransform(computed.transform) };
  }

  private loadFilterBase(): void {
    if (this.filterBaseLoaded) return;
    this.filterBaseLoaded = true;
    const computed = readComputed(this.element, ["filter"]);
    this.filterValue = decomposeFilter(computed.filter);
  }

  /**
   * Record a computed value for a property.
   * `raw` is the resolved value used to seed the next animation.
   */
  set(name: string, value: string | number, raw?: Primitive): void {
    const definition = getPropertyDefinition(name);
    if (!definition) return;
    const numeric = typeof value === "number" ? value : parseFloat(value);
    this.dirty = true;

    switch (definition.channel) {
      case "transform": {
        this.transformTouched = true;
        for (const key of definition.transformKeys ?? []) {
          this.transform[key] = Number.isNaN(numeric) ? 0 : numeric;
        }
        break;
      }
      case "filter": {
        this.filterTouched = true;
        const key = definition.filterKey ?? definition.name;
        this.filterValue[key] = typeof value === "string" && Number.isNaN(numeric) ? value : numeric;
        break;
      }
      case "cssvar": {
        this.cssVars.set(definition.cssProperty ?? name, String(value));
        break;
      }
      case "svg": {
        this.svgValues.set(definition.cssProperty ?? name, String(value));
        break;
      }
      default: {
        this.styleValues.set(definition.cssProperty ?? toKebab(name), String(value));
      }
    }

    this.lastValues.set(name, raw ?? value);
  }

  /** Read back the last value recorded for a logical property. */
  peek(name: string): string | undefined {
    const definition = getPropertyDefinition(name);
    if (!definition) return undefined;
    if (definition.channel === "transform") {
      const key = definition.transformKeys?.[0];
      const value = key ? this.transform[key] : undefined;
      return value === undefined ? undefined : String(value);
    }
    if (definition.channel === "filter") return String(this.filterValue[definition.filterKey ?? name] ?? "");
    if (definition.channel === "cssvar") return this.cssVars.get(definition.cssProperty ?? name);
    if (definition.channel === "svg") return this.svgValues.get(definition.cssProperty ?? name);
    return this.styleValues.get(definition.cssProperty ?? name);
  }

  /** Write every recorded value to the DOM. Called once per frame by the pool. */
  commit(): void {
    this.dirty = false;
    const style = (this.element as HTMLElement).style;
    if (!style) return;
    const time = this.host.now();
    const precision = this.host.precision();

    if (this.transformTouched) {
      const value = composeTransform(roundTransform(this.transform, precision));
      style.transform = value;
      this.host.onWrite({ element: this.element, property: "transform", cssProperty: "transform", channel: "transform", value, time });
      this.applyHints("transform");
    }

    if (this.filterTouched) {
      const value = composeFilter(this.filterValue);
      style.filter = value;
      this.host.onWrite({ element: this.element, property: "filter", cssProperty: "filter", channel: "filter", value, time });
      this.applyHints("filter");
    }

    for (const [cssProperty, value] of this.styleValues) {
      style.setProperty(cssProperty, value);
      this.host.onWrite({ element: this.element, property: cssProperty, cssProperty, channel: "style", value, time });
    }

    for (const [cssProperty, value] of this.cssVars) {
      style.setProperty(cssProperty, value);
      this.host.onWrite({ element: this.element, property: cssProperty, cssProperty, channel: "cssvar", value, time });
    }

    for (const [attribute, value] of this.svgValues) {
      this.element.setAttribute(attribute, value);
      this.host.onWrite({ element: this.element, property: attribute, cssProperty: attribute, channel: "svg", value, time });
    }
  }

  /**
   * Apply compositor hints once per element, and only for properties that
   * benefit. `will-change` is expensive if left on, so the pool releases it
   * when nothing is animating the element any more.
   */
  private applyHints(kind: "transform" | "filter"): void {
    if (!this.host.gpuHints()) return;
    const style = (this.element as HTMLElement).style;
    if (!style) return;
    const current = style.getPropertyValue("will-change");
    const desired = kind === "transform" ? "transform" : "transform, filter, opacity";
    if (current === desired) return;
    if (this.hintsApplied && current === "") return;
    style.setProperty("will-change", desired);
    this.hintsApplied = true;
  }

  /** Remove compositor hints (called when the element goes idle). */
  releaseHints(): void {
    if (!this.hintsApplied) return;
    (this.element as HTMLElement).style?.removeProperty("will-change");
    this.hintsApplied = false;
  }

  /** Force-clear the writer cache (used by tests and the Motion Lab). */
  reset(): void {
    this.transform = {};
    this.filterValue = {};
    this.styleValues.clear();
    this.cssVars.clear();
    this.svgValues.clear();
    this.lastValues.clear();
    this.transformTouched = false;
    this.filterTouched = false;
    this.transformBaseLoaded = false;
    this.filterBaseLoaded = false;
  }
}

export function roundTransform(state: TransformState, precision: number): TransformState {
  const out: TransformState = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === "number") (out as any)[key] = round(value, precision);
  }
  return out;
}

function parseNumericOrString(raw: string, identity: Primitive): Primitive {
  if (typeof identity === "number") {
    const parsed = parseFloat(raw);
    return Number.isNaN(parsed) ? identity : parsed;
  }
  return raw;
}