/**
 * The Waves property registry — every primitive the engine can animate.
 *
 * Each definition declares *how* the value is written (channel), *what* it
 * interpolates as, and *what it costs* the compositor. The performance
 * classifier, the schema, the CLI listings and the inspector all read from
 * this single table, so a new primitive is added in exactly one place.
 */

import type { PropertyCost, StyleChannel, Unit, ValueKind } from "../types";
import type { TransformState } from "./values";

export interface PropertyDefinition {
  name: string;
  /** Logical alias exposed to users/AI (may differ from `name`). */
  alias?: string;
  channel: StyleChannel;
  /** Target for `style` / `cssvar` / `svg` / `text` channels. */
  cssProperty?: string;
  /** Transform components this property drives. */
  transformKeys?: (keyof TransformState)[];
  /** Filter component key. */
  filterKey?: string;
  unit: Unit;
  kind: ValueKind;
  /** Value that means "no visual effect" — the default start point. */
  identity: number | string;
  cost: PropertyCost;
  /** Value cannot be interpolated; it swaps at the 50% point. */
  discrete?: boolean;
  /** Also mirrored onto the SVG attribute of the same name. */
  svgAttribute?: boolean;
  description: string;
}

export const PROPERTY_REGISTRY: Record<string, PropertyDefinition> = {
  /* ---------------------------------- transform --------------------------------- */
  x: {
    name: "x",
    alias: "translateX",
    channel: "transform",
    transformKeys: ["translateX"],
    unit: "px",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Horizontal translation in px. GPU-composited."
  },
  translateX: {
    name: "translateX",
    channel: "transform",
    transformKeys: ["translateX"],
    unit: "px",
    kind: "unit",
    identity: 0,
    cost: "composite",
    description: "Alias of `x` that also accepts unit strings."
  },
  y: {
    name: "y",
    alias: "translateY",
    channel: "transform",
    transformKeys: ["translateY"],
    unit: "px",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Vertical translation in px. GPU-composited."
  },
  translateY: {
    name: "translateY",
    channel: "transform",
    transformKeys: ["translateY"],
    unit: "px",
    kind: "unit",
    identity: 0,
    cost: "composite",
    description: "Alias of `y` that also accepts unit strings."
  },
  z: {
    name: "z",
    alias: "translateZ",
    channel: "transform",
    transformKeys: ["translateZ"],
    unit: "px",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Depth translation — layered depth in card stacks."
  },
  scale: {
    name: "scale",
    channel: "transform",
    transformKeys: ["scaleX", "scaleY"],
    unit: "",
    kind: "number",
    identity: 1,
    cost: "composite",
    description: "Uniform scale. Drives both scaleX and scaleY."
  },
  scaleX: {
    name: "scaleX",
    channel: "transform",
    transformKeys: ["scaleX"],
    unit: "",
    kind: "number",
    identity: 1,
    cost: "composite",
    description: "Horizontal scale."
  },
  scaleY: {
    name: "scaleY",
    channel: "transform",
    transformKeys: ["scaleY"],
    unit: "",
    kind: "number",
    identity: 1,
    cost: "composite",
    description: "Vertical scale."
  },
  rotate: {
    name: "rotate",
    channel: "transform",
    transformKeys: ["rotate"],
    unit: "deg",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "2D rotation in degrees. Waves keeps this under a few degrees."
  },
  rotateX: {
    name: "rotateX",
    channel: "transform",
    transformKeys: ["rotateX"],
    unit: "deg",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Rotation about the X axis — depth entrances."
  },
  rotateY: {
    name: "rotateY",
    channel: "transform",
    transformKeys: ["rotateY"],
    unit: "deg",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Rotation about the Y axis — depth entrances."
  },
  skewX: {
    name: "skewX",
    channel: "transform",
    transformKeys: ["skewX"],
    unit: "deg",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Horizontal skew."
  },
  skewY: {
    name: "skewY",
    channel: "transform",
    transformKeys: ["skewY"],
    unit: "deg",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Vertical skew."
  },
  perspective: {
    name: "perspective",
    channel: "transform",
    transformKeys: ["perspective"],
    unit: "px",
    kind: "number",
    identity: 0,
    cost: "composite",
    description: "Perspective distance applied inside the transform list."
  },
  transformOrigin: {
    name: "transformOrigin",
    channel: "style",
    cssProperty: "transform-origin",
    unit: "%",
    kind: "transform",
    identity: "50% 50%",
    cost: "paint",
    description: "Origin of the transform, e.g. `\"50% 100%\"` for bottom-anchored rises."
  },

  /* ------------------------------------ style ----------------------------------- */
  opacity: {
    name: "opacity",
    channel: "style",
    cssProperty: "opacity",
    unit: "",
    kind: "number",
    identity: 1,
    cost: "composite",
    description: "Layer opacity. Always safe to animate."
  },
  width: {
    name: "width",
    channel: "style",
    cssProperty: "width",
    unit: "px",
    kind: "unit",
    identity: "auto",
    cost: "layout",
    description: "Element width. Layout-triggering — prefer scale when possible."
  },
  height: {
    name: "height",
    channel: "style",
    cssProperty: "height",
    unit: "px",
    kind: "unit",
    identity: "auto",
    cost: "layout",
    description: "Element height. Layout-triggering — used by expand/collapse."
  },
  top: {
    name: "top",
    channel: "style",
    cssProperty: "top",
    unit: "px",
    kind: "unit",
    identity: "auto",
    cost: "layout",
    description: "Positioned offset from the top."
  },
  left: {
    name: "left",
    channel: "style",
    cssProperty: "left",
    unit: "px",
    kind: "unit",
    identity: "auto",
    cost: "layout",
    description: "Positioned offset from the left."
  },
  right: {
    name: "right",
    channel: "style",
    cssProperty: "right",
    unit: "px",
    kind: "unit",
    identity: "auto",
    cost: "layout",
    description: "Positioned offset from the right."
  },
  bottom: {
    name: "bottom",
    channel: "style",
    cssProperty: "bottom",
    unit: "px",
    kind: "unit",
    identity: "auto",
    cost: "layout",
    description: "Positioned offset from the bottom."
  },
  fontSize: {
    name: "fontSize",
    channel: "style",
    cssProperty: "font-size",
    unit: "px",
    kind: "unit",
    identity: "inherit",
    cost: "layout",
    description: "Font size — layout-triggering; small ranges only."
  },
  lineHeight: {
    name: "lineHeight",
    channel: "style",
    cssProperty: "line-height",
    unit: "",
    kind: "unit",
    identity: "normal",
    cost: "layout",
    description: "Line height."
  },
  letterSpacing: {
    name: "letterSpacing",
    channel: "style",
    cssProperty: "letter-spacing",
    unit: "em",
    kind: "unit",
    identity: "normal",
    cost: "layout",
    description: "Letter spacing — the Waves text tracking settle."
  },
  wordSpacing: {
    name: "wordSpacing",
    channel: "style",
    cssProperty: "word-spacing",
    unit: "em",
    kind: "unit",
    identity: "normal",
    cost: "layout",
    description: "Word spacing."
  },
  textIndent: {
    name: "textIndent",
    channel: "style",
    cssProperty: "text-indent",
    unit: "px",
    kind: "unit",
    identity: 0,
    cost: "layout",
    description: "Text indent."
  },
  gap: {
    name: "gap",
    channel: "style",
    cssProperty: "gap",
    unit: "px",
    kind: "unit",
    identity: 0,
    cost: "layout",
    description: "Grid/flex gap."
  },
  backgroundColor: {
    name: "backgroundColor",
    channel: "style",
    cssProperty: "background-color",
    unit: "",
    kind: "color",
    identity: "transparent",
    cost: "paint",
    description: "Background colour — interpolated in RGB."
  },
  color: {
    name: "color",
    channel: "style",
    cssProperty: "color",
    unit: "",
    kind: "color",
    identity: "inherit",
    cost: "paint",
    description: "Text colour — interpolated in RGB."
  },
  borderColor: {
    name: "borderColor",
    channel: "style",
    cssProperty: "border-color",
    unit: "",
    kind: "color",
    identity: "transparent",
    cost: "paint",
    description: "Border colour."
  },
  clipPath: {
    name: "clipPath",
    channel: "style",
    cssProperty: "clip-path",
    unit: "%",
    kind: "transform",
    identity: "inset(0% 0% 0% 0%)",
    cost: "paint",
    description: "Clip path — `inset(...)` progressions interpolate component-wise."
  },
  boxShadow: {
    name: "boxShadow",
    channel: "style",
    cssProperty: "box-shadow",
    unit: "px",
    kind: "string",
    identity: "none",
    cost: "expensive",
    discrete: true,
    description: "Box shadow (discrete). Expensive to repaint — use depth layers instead."
  },
  zIndex: {
    name: "zIndex",
    channel: "style",
    cssProperty: "z-index",
    unit: "",
    kind: "string",
    identity: 0,
    cost: "paint",
    discrete: true,
    description: "Stacking order (discrete)."
  },
  visibility: {
    name: "visibility",
    channel: "style",
    cssProperty: "visibility",
    unit: "",
    kind: "string",
    identity: "visible",
    cost: "paint",
    discrete: true,
    description: "Visibility (discrete)."
  },
  pointerEvents: {
    name: "pointerEvents",
    channel: "style",
    cssProperty: "pointer-events",
    unit: "",
    kind: "string",
    identity: "auto",
    cost: "composite",
    discrete: true,
    description: "Pointer events (discrete) — locks a target during a sequence."
  },
  borderRadius: {
    name: "borderRadius",
    channel: "style",
    cssProperty: "border-radius",
    unit: "px",
    kind: "unit",
    identity: 0,
    cost: "paint",
    description: "Corner radius (all corners)."
  },

  /* ------------------------------------ filter ---------------------------------- */
  blur: {
    name: "blur",
    channel: "filter",
    filterKey: "blur",
    unit: "px",
    kind: "number",
    identity: 0,
    cost: "paint",
    description: "Gaussian blur in px. Keep under 8px — the Waves restrained blur."
  },
  brightness: {
    name: "brightness",
    channel: "filter",
    filterKey: "brightness",
    unit: "",
    kind: "number",
    identity: 1,
    cost: "paint",
    description: "Brightness multiplier (1 = unchanged)."
  },
  contrast: {
    name: "contrast",
    channel: "filter",
    filterKey: "contrast",
    unit: "",
    kind: "number",
    identity: 1,
    cost: "paint",
    description: "Contrast multiplier (1 = unchanged)."
  },
  saturate: {
    name: "saturate",
    channel: "filter",
    filterKey: "saturate",
    unit: "",
    kind: "number",
    identity: 1,
    cost: "paint",
    description: "Saturation multiplier (1 = unchanged)."
  },
  grayscale: {
    name: "grayscale",
    channel: "filter",
    filterKey: "grayscale",
    unit: "",
    kind: "number",
    identity: 0,
    cost: "paint",
    description: "Greyscale amount 0–1."
  },
  sepia: {
    name: "sepia",
    channel: "filter",
    filterKey: "sepia",
    unit: "",
    kind: "number",
    identity: 0,
    cost: "paint",
    description: "Sepia amount 0–1."
  },
  invert: {
    name: "invert",
    channel: "filter",
    filterKey: "invert",
    unit: "",
    kind: "number",
    identity: 0,
    cost: "paint",
    description: "Invert amount 0–1."
  },
  hueRotate: {
    name: "hueRotate",
    channel: "filter",
    filterKey: "hueRotate",
    unit: "deg",
    kind: "number",
    identity: 0,
    cost: "paint",
    description: "Hue rotation in degrees."
  },
  dropShadow: {
    name: "dropShadow",
    channel: "filter",
    filterKey: "dropShadow",
    unit: "px",
    kind: "string",
    identity: "0 0 0 rgba(0,0,0,0)",
    cost: "expensive",
    discrete: true,
    description: "Drop shadow inside the filter list (discrete, expensive)."
  },

  /* ------------------------------------- SVG ------------------------------------ */
  fillOpacity: {
    name: "fillOpacity",
    channel: "style",
    cssProperty: "fill-opacity",
    unit: "",
    kind: "number",
    identity: 1,
    cost: "paint",
    svgAttribute: true,
    description: "SVG fill opacity."
  },
  strokeWidth: {
    name: "strokeWidth",
    channel: "style",
    cssProperty: "stroke-width",
    unit: "px",
    kind: "unit",
    identity: 1,
    cost: "paint",
    svgAttribute: true,
    description: "SVG stroke width."
  },
  strokeDashoffset: {
    name: "strokeDashoffset",
    channel: "style",
    cssProperty: "stroke-dashoffset",
    unit: "px",
    kind: "number",
    identity: 0,
    cost: "paint",
    description: "SVG dash offset — powers the `draw` / line-reveal motion."
  },
  pathLength: {
    name: "pathLength",
    channel: "style",
    cssProperty: "stroke-dasharray",
    unit: "px",
    kind: "number",
    identity: 0,
    cost: "paint",
    description: "SVG path length driven through `stroke-dasharray`."
  }
};

/* -------------------------------------------------------------------------- */
/* Registry helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a property name to its definition.
 * Handles CSS custom properties (`--waves-accent`) and SVG attributes
 * (`attr:r`) dynamically, since those are open-ended.
 */
export function getPropertyDefinition(name: string): PropertyDefinition | null {
  const direct = PROPERTY_REGISTRY[name];
  if (direct) return direct;

  if (name.startsWith("--")) {
    return {
      name,
      channel: "cssvar",
      cssProperty: name,
      unit: "",
      kind: guessCssVarKind(name),
      identity: 0,
      cost: "composite",
      description: `CSS custom property ${name}. Animating a custom property is composited when consumed by transform/opacity.`
    };
  }

  if (name.startsWith("attr:")) {
    const attribute = name.slice(5);
    return {
      name,
      channel: "svg",
      cssProperty: attribute,
      unit: "px",
      kind: "number",
      identity: 0,
      cost: "paint",
      description: `SVG attribute "${attribute}".`
    };
  }

  return null;
}

function guessCssVarKind(name: string): ValueKind {
  if (/color|bg|background|fill|stroke/.test(name)) return "color";
  return "number";
}

/** True when the engine can animate this property. */
export function isAnimatableProperty(name: string): boolean {
  return getPropertyDefinition(name) !== null;
}

/** Performance classification for a single property (used by warnings + CLI). */
export function classifyProperty(name: string): PropertyCost {
  return getPropertyDefinition(name)?.cost ?? "paint";
}

/** Sorted list of every registered property, for CLI listings and the schema. */
export function listProperties(): PropertyDefinition[] {
  return Object.values(PROPERTY_REGISTRY).sort((a, b) => a.name.localeCompare(b.name));
}

/** Group the registry by channel — the AI interface renders this as a catalog. */
export function listPropertiesByChannel(): Record<StyleChannel, PropertyDefinition[]> {
  const grouped: Record<StyleChannel, PropertyDefinition[]> = {
    transform: [],
    filter: [],
    style: [],
    cssvar: [],
    svg: [],
    text: []
  };
  for (const definition of listProperties()) grouped[definition.channel].push(definition);
  return grouped;
}