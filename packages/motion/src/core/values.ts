/**
 * Value parsing + interpolation engine.
 *
 * Handles every primitive the engine animates: plain numbers, unit values
 * (px/%/deg/rem…), colours, transform components, filter components,
 * clip-paths, CSS variables, SVG attributes and arbitrary structured strings.
 *
 * Structured strings (e.g. `inset(8px 12px 8px 12px)`) are interpolated
 * component-wise by matching their numeric skeleton; when the skeletons differ
 * the value degrades to a discrete swap rather than producing garbage.
 */

import type { Primitive, Unit, ValueKind } from "../types";

export interface ParsedValue {
  kind: ValueKind;
  raw: string;
  /** Numeric components found in the value. */
  numbers: number[];
  /** The value with every number replaced by a slot marker. */
  skeleton: string;
  unit: Unit;
  /** Filter function name when `kind === "filter"`. */
  filterName?: string;
}

const UNIT_PATTERN = /^(-?\d*\.?\d+)(px|%|em|rem|vw|vh|vmin|vmax|deg|rad|turn|ms|s)?$/;

const FILTER_FUNCTIONS = [
  "blur",
  "brightness",
  "contrast",
  "saturate",
  "grayscale",
  "sepia",
  "hue-rotate",
  "invert",
  "opacity",
  "drop-shadow"
] as const;

/** Placeholder used when matching numeric skeletons. */
const SLOT = "\u0000";

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [Math.round(hue(p, q, h + 1 / 3) * 255), Math.round(hue(p, q, h) * 255), Math.round(hue(p, q, h - 1 / 3) * 255)];
}

/** Parse a colour into RGBA channels, or null when it isn't a colour. */
export function parseColor(input: string): [number, number, number, number] | null {
  const value = input.trim().toLowerCase();
  if (value === "transparent") return [0, 0, 0, 0];

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return [r, g, b, a];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    return null;
  }

  const match = value.match(/^rgba?\(([^)]+)\)$/);
  if (match) {
    const parts = match[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (raw: string, scale: number) => {
      const numeric = raw.endsWith("%") ? (parseFloat(raw) / 100) * scale : parseFloat(raw);
      return Number.isNaN(numeric) ? 0 : numeric;
    };
    const r = channel(parts[0], 255);
    const g = channel(parts[1], 255);
    const b = channel(parts[2], 255);
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return [r, g, b, Number.isNaN(alpha) ? 1 : alpha];
  }

  const hsl = value.match(/^hsla?\(([^)]+)\)$/);
  if (hsl) {
    const parts = hsl[1].split(/[,\s/]+/).filter(Boolean);
    const h = parseFloat(parts[0]) / 360;
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const a = parts[3] === undefined ? 1 : parseFloat(parts[3]);
    const [r, g, b] = hslToRgb(h, s, l);
    return [r, g, b, a];
  }

  const NAMED: Record<string, [number, number, number, number]> = {
    white: [255, 255, 255, 1],
    black: [0, 0, 0, 1],
    red: [255, 0, 0, 1],
    green: [0, 128, 0, 1],
    blue: [0, 0, 255, 1],
    gray: [128, 128, 128, 1],
    grey: [128, 128, 128, 1]
  };
  return NAMED[value] ?? null;
}

export function formatColor(channels: [number, number, number, number]): string {
  const [r, g, b, a] = channels;
  const rr = Math.round(clamp(r, 0, 255));
  const gg = Math.round(clamp(g, 0, 255));
  const bb = Math.round(clamp(b, 0, 255));
  if (a >= 1) return `rgb(${rr}, ${gg}, ${bb})`;
  return `rgba(${rr}, ${gg}, ${bb}, ${round(a, 3)})`;
}

/** Replace every number in a string with the slot marker, collecting the numbers. */
export function extractNumbers(input: string): { skeleton: string; numbers: number[] } {
  const numbers: number[] = [];
  const skeleton = input.replace(/(-?\d*\.?\d+)([a-z%]*)/gi, (_match, num: string, unit: string) => {
    numbers.push(parseFloat(num));
    return SLOT + unit;
  });
  return { skeleton, numbers };
}

/** Parse a value into a structured, interpolatable form. */
export function parseValue(value: Primitive, hint?: { kind?: ValueKind; unit?: Unit; filterName?: string }): ParsedValue {
  if (typeof value === "number") {
    return {
      kind: hint?.kind ?? "number",
      raw: String(value),
      numbers: [value],
      skeleton: SLOT + (hint?.unit ?? ""),
      unit: hint?.unit ?? "",
      filterName: hint?.filterName
    };
  }

  const raw = String(value).trim();

  const color = parseColor(raw);
  if (color && hint?.kind !== "string" && !FILTER_LIKE.test(raw)) {
    return {
      kind: "color",
      raw,
      numbers: color,
      skeleton: "rgba(" + SLOT + "," + SLOT + "," + SLOT + "," + SLOT + ")",
      unit: ""
    };
  }

  const filterMatch = raw.match(/^([a-z-]+)\((.*)\)$/i);
  if (filterMatch && (FILTER_FUNCTIONS as readonly string[]).includes(filterMatch[1].toLowerCase())) {
    const name = filterMatch[1].toLowerCase();
    const inner = filterMatch[2].trim();
    const { skeleton, numbers } = extractNumbers(inner);
    if (numbers.length === 0) {
      return { kind: "string", raw, numbers: [], skeleton: raw, unit: "", filterName: name };
    }
    return {
      kind: "filter",
      raw,
      numbers,
      skeleton: `${name}(${skeleton})`,
      unit: /deg/.test(inner) ? "deg" : /%/.test(inner) ? "%" : "",
      filterName: name
    };
  }

  const unitMatch = raw.match(UNIT_PATTERN);
  if (unitMatch) {
    return {
      kind: unitMatch[2] ? "unit" : hint?.kind === "unit" ? "unit" : "number",
      raw,
      numbers: [parseFloat(unitMatch[1])],
      skeleton: SLOT + (unitMatch[2] ?? hint?.unit ?? ""),
      unit: (unitMatch[2] as Unit) ?? hint?.unit ?? ""
    };
  }

  const { skeleton, numbers } = extractNumbers(raw);
  if (numbers.length > 0) {
    return {
      kind: hint?.kind ?? "transform",
      raw,
      numbers,
      skeleton,
      unit: hint?.unit ?? ""
    };
  }

  return { kind: "string", raw, numbers: [], skeleton: raw, unit: hint?.unit ?? "" };
}

/** Values that must never be treated as colours even if they parse as one. */
const FILTER_LIKE = /^(blur|brightness|contrast|saturate|grayscale|sepia|invert|hue-rotate|drop-shadow|inset|polygon|circle|ellipse|path|translate|scale|rotate|skew|matrix)/;

/**
 * Interpolate two parsed values. Returns a CSS-ready string.
 * `progress` is 0 – 1; easing must already be applied by the caller.
 */
export function interpolateValues(from: ParsedValue, to: ParsedValue, progress: number): string {
  if (progress <= 0) return from.raw;
  if (progress >= 1) return to.raw;

  if (from.kind === "string" || to.kind === "string") return progress < 0.5 ? from.raw : to.raw;
  if (from.skeleton !== to.skeleton) {
    // Structure changed (different layer counts, different clip shapes, …).
    return progress < 0.5 ? from.raw : to.raw;
  }

  if (from.kind === "color") {
    const a = from.numbers;
    const b = to.numbers;
    const mix = (i: number) => a[i] + (b[i] - a[i]) * progress;
    return formatColor([mix(0), mix(1), mix(2), mix(3)]);
  }

  const numbers = from.numbers.map((value, index) => {
    const target = to.numbers[index];
    if (target === undefined) return value;
    return value + (target - value) * progress;
  });

  let index = 0;
  return from.skeleton.replace(new RegExp(SLOT, "g"), () => String(round(numbers[index++] ?? 0, 4)));
}

/** Convenience: interpolate two raw values without pre-parsing. */
export function interpolateRaw(from: Primitive, to: Primitive, progress: number, hint?: { kind?: ValueKind; unit?: Unit }): string {
  return interpolateValues(parseValue(from, hint), parseValue(to, hint), progress);
}

/* -------------------------------------------------------------------------- */
/* Transform + filter composition                                             */
/* -------------------------------------------------------------------------- */

export interface TransformState {
  translateX?: number;
  translateY?: number;
  translateZ?: number;
  scaleX?: number;
  scaleY?: number;
  rotate?: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  skewX?: number;
  skewY?: number;
  perspective?: number;
}

/**
 * Compose a transform string from per-component numbers.
 *
 * The order is fixed by the engine so concurrent animations on different
 * components always produce the same result:
 * perspective → translate → rotate → skew → scale.
 */
export function composeTransform(state: TransformState): string {
  const parts: string[] = [];
  if (state.perspective !== undefined) parts.push(`perspective(${round(state.perspective, 2)}px)`);
  if (state.translateX !== undefined || state.translateY !== undefined || state.translateZ !== undefined) {
    parts.push(
      `translate3d(${round(state.translateX ?? 0, 3)}px, ${round(state.translateY ?? 0, 3)}px, ${round(state.translateZ ?? 0, 3)}px)`
    );
  }
  if (state.rotateX !== undefined || state.rotateY !== undefined) {
    parts.push(`rotateX(${round(state.rotateX ?? 0, 3)}deg) rotateY(${round(state.rotateY ?? 0, 3)}deg)`);
  }
  const rotateZ = state.rotateZ ?? state.rotate;
  if (rotateZ !== undefined) parts.push(`rotate(${round(rotateZ, 3)}deg)`);
  if (state.skewX !== undefined || state.skewY !== undefined) {
    parts.push(`skew(${round(state.skewX ?? 0, 3)}deg, ${round(state.skewY ?? 0, 3)}deg)`);
  }
  if (state.scaleX !== undefined || state.scaleY !== undefined) {
    parts.push(`scale(${round(state.scaleX ?? 1, 4)}, ${round(state.scaleY ?? 1, 4)})`);
  }
  return parts.length ? parts.join(" ") : "none";
}

/** Compose a filter string from per-component numbers. */
export function composeFilter(state: Record<string, number | string | undefined>): string {
  const parts: string[] = [];
  const push = (name: string, value: number | string | undefined, unit: string) => {
    if (value === undefined) return;
    parts.push(`${name}(${typeof value === "number" ? round(value, 3) : value}${unit})`);
  };
  push("blur", state.blur, "px");
  push("brightness", state.brightness, "");
  push("contrast", state.contrast, "");
  push("saturate", state.saturate, "");
  push("grayscale", state.grayscale, "");
  push("sepia", state.sepia, "");
  push("invert", state.invert, "");
  if (state.hueRotate !== undefined) parts.push(`hue-rotate(${round(Number(state.hueRotate), 3)}deg)`);
  if (typeof state.dropShadow === "string") parts.push(`drop-shadow(${state.dropShadow})`);
  return parts.length ? parts.join(" ") : "none";
}

/** Decompose a computed `matrix(...)` / `matrix3d(...)` into transform state. */
export function decomposeTransform(transform: string | null | undefined): TransformState {
  if (!transform || transform === "none") return {};
  const values = transform
    .replace(/^matrix3d?\(/i, "")
    .replace(/\)$/, "")
    .split(",")
    .map((part) => parseFloat(part.trim()));
  if (!values.length || values.some((value) => Number.isNaN(value))) return {};

  if (values.length === 6) {
    const [a, b, c, d, e, f] = values;
    const scaleX = Math.hypot(a, b);
    const scaleY = Math.hypot(c, d);
    const rotate = Math.atan2(b, a) * (180 / Math.PI);
    return { translateX: e, translateY: f, scaleX: scaleX || 1, scaleY: scaleY || 1, rotate };
  }

  if (values.length === 16) {
    const scaleX = Math.hypot(values[0], values[1], values[2]);
    const scaleY = Math.hypot(values[4], values[5], values[6]);
    const rotateZ = Math.atan2(values[1], values[0]) * (180 / Math.PI);
    const rotateY = Math.asin(clamp(-values[2] / (scaleX || 1), -1, 1)) * (180 / Math.PI);
    const rotateX = Math.atan2(values[6] / (scaleY || 1), values[5] / (scaleY || 1)) * (180 / Math.PI);
    return {
      translateX: values[12],
      translateY: values[13],
      translateZ: values[14],
      scaleX: scaleX || 1,
      scaleY: scaleY || 1,
      rotateX,
      rotateY,
      rotateZ,
      rotate: rotateZ
    };
  }

  return {};
}

/** Split a computed `filter` string into its component values. */
export function decomposeFilter(filter: string | null | undefined): Record<string, number | string> {
  const state: Record<string, number | string> = {};
  if (!filter || filter === "none") return state;
  const pattern = /([a-z-]+)\(([^)]+)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(filter))) {
    const name = match[1].toLowerCase();
    const inner = match[2].trim();
    const numeric = parseFloat(inner);
    const key = name === "hue-rotate" ? "hueRotate" : name === "drop-shadow" ? "dropShadow" : name;
    state[key] = name === "drop-shadow" ? inner : Number.isNaN(numeric) ? inner : numeric;
  }
  return state;
}