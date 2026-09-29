import { describe, expect, it } from "vitest";
import { validateGsapSpec, type GsapSceneSpec } from "@waves/motion";

function scene(ops: GsapSceneSpec["ops"]): GsapSceneSpec {
  return { version: 1, name: "test", ops };
}

const tween = (overrides: Record<string, unknown> = {}) => ({
  id: "t1",
  type: "tween",
  target: ".hero",
  to: { opacity: 1 },
  duration: 0.8,
  ...overrides
});

describe("gsap spec validation", () => {
  it("accepts a valid scene", () => {
    const report = validateGsapSpec(
      scene([tween(), { id: "s1", type: "set", target: ".hero", to: { opacity: 0 } }]),
      { resolveTarget: () => 1 }
    );
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.targetsChecked).toBe(true);
  });
  it("rejects bad shapes, dup ids, unknown types", () => {
    expect(validateGsapSpec(null).ok).toBe(false);
    expect(validateGsapSpec({ version: 2, name: "x", ops: [] }).ok).toBe(false);
    expect(validateGsapSpec(scene([tween(), tween()])).errors.some((e) => e.code === "GSAP_DUP_ID")).toBe(true);
    expect(validateGsapSpec(scene([{ ...tween(), type: "explode" }])).errors.some((e) => e.code === "GSAP_OP_TYPE")).toBe(true);
  });
  it("checks targets only when a resolver is given", () => {
    const missing = validateGsapSpec(scene([tween()]), { resolveTarget: () => 0 });
    expect(missing.errors.some((e) => e.code === "GSAP_TARGET_MISSING")).toBe(true);
    expect(validateGsapSpec(scene([tween()])).targetsChecked).toBe(false);
    expect(validateGsapSpec(scene([tween()])).ok).toBe(true);
  });
  it("rejects NaN/Infinity/negative timing", () => {
    expect(validateGsapSpec(scene([tween({ duration: NaN })])).errors.some((e) => e.code === "GSAP_DURATION")).toBe(true);
    expect(validateGsapSpec(scene([tween({ duration: -1 })])).errors.some((e) => e.code === "GSAP_DURATION")).toBe(true);
    expect(validateGsapSpec(scene([tween({ delay: Infinity })])).errors.some((e) => e.code === "GSAP_DELAY")).toBe(true);
    expect(validateGsapSpec(scene([tween({ position: -2 })])).errors.some((e) => e.code === "GSAP_POSITION")).toBe(true);
    expect(validateGsapSpec(scene([tween({ position: "!!!" })])).errors.some((e) => e.code === "GSAP_POSITION")).toBe(true);
    // Bare words are label references: valid, with a dangling-label warning.
    expect(validateGsapSpec(scene([tween({ position: "whenever" })])).warnings.some((e) => e.code === "GSAP_LABEL_REF")).toBe(true);
  });
  it("validates easings against GSAP core grammar", () => {
    expect(validateGsapSpec(scene([tween({ ease: "power3.out" })])).ok).toBe(true);
    expect(validateGsapSpec(scene([tween({ ease: "elastic.out(1,0.5)" })])).ok).toBe(true);
    expect(validateGsapSpec(scene([tween({ ease: "bounce.in" })])).ok).toBe(true);
    const bad = validateGsapSpec(scene([tween({ ease: "wiggle" })]));
    expect(bad.errors.some((e) => e.code === "GSAP_UNKNOWN_EASE")).toBe(true);
    const params = validateGsapSpec(scene([tween({ ease: "back.out(banana)" })]));
    expect(params.errors.some((e) => e.code === "GSAP_EASE_PARAMS")).toBe(true);
  });
  it("warns on layout properties, errors on impossible values", () => {
    const layout = validateGsapSpec(scene([tween({ to: { width: 100 } })]));
    expect(layout.ok).toBe(true);
    expect(layout.warnings.some((w) => w.code === "GSAP_LAYOUT_PROP")).toBe(true);
    expect(validateGsapSpec(scene([tween({ to: { opacity: NaN } })])).errors.some((e) => e.code === "GSAP_PROP_RANGE")).toBe(true);
  });
  it("validates stagger, spring, motion-path, parallax, scrub", () => {
    const stagger = { id: "g1", type: "stagger", target: ".c", to: { opacity: 1 }, stagger: -1 };
    expect(validateGsapSpec(scene([tween(), stagger])).errors.some((e) => e.code === "GSAP_STAGGER")).toBe(true);
    const spring = { id: "sp", type: "spring", target: ".x", to: { y: 0 }, spring: "nope" };
    expect(validateGsapSpec(scene([tween(), spring])).errors.some((e) => e.code === "GSAP_SPRING")).toBe(true);
    const springOk = { id: "sp", type: "spring", target: ".x", to: { y: 0 }, spring: { stiffness: 200, damping: 20 } };
    expect(validateGsapSpec(scene([tween(), springOk]), { resolveTarget: () => 1 }).ok).toBe(true);
    const path = { id: "mp", type: "motion-path", target: ".dot", path: "hello", duration: 1 };
    expect(validateGsapSpec(scene([tween(), path])).errors.some((e) => e.code === "GSAP_MOTION_PATH")).toBe(true);
    const pathOk = { id: "mp", type: "motion-path", target: ".dot", path: "M0,0 L100,100", duration: 1 };
    expect(validateGsapSpec(scene([tween(), pathOk]), { resolveTarget: () => 1 }).ok).toBe(true);
    const par = { id: "px", type: "parallax", target: ".bg", speed: Infinity };
    expect(validateGsapSpec(scene([tween(), par])).errors.some((e) => e.code === "GSAP_PARALLAX")).toBe(true);
    const scrub = { id: "sc", type: "scroll", target: ".s", to: { y: 0 }, scrub: -2 };
    expect(validateGsapSpec(scene([tween(), scrub])).errors.some((e) => e.code === "GSAP_SCRUB")).toBe(true);
  });
  it("warns on dangling label references", () => {
    const report = validateGsapSpec(scene([tween({ position: "ghost+=0.2" })]));
    expect(report.ok).toBe(true);
    expect(report.warnings.some((w) => w.code === "GSAP_LABEL_REF")).toBe(true);
  });
});
