import { describe, expect, it } from "vitest";
import { createSpringEasing, describeSpring, normalizeSpring, springPhysics, springSettlingTime, SpringValue } from "../src/spring";
import { defaultMotionTokens } from "../src/core/tokens";
import { cubicBezier, easingToCss, listEasings, resolveEasing, sampleEasing } from "../src/easing";

describe("spring physics", () => {
  it("reports the house spring as essentially critically damped and not bouncy", () => {
    const physics = springPhysics(defaultMotionTokens.spring.waves);
    expect(physics.zeta).toBeGreaterThan(0.98);
    expect(physics.zeta).toBeLessThan(1.02);
    expect(physics.overshoot).toBeLessThan(0.001);

    const report = describeSpring();
    expect(report.verdict).toBe("restrained");
    expect(report.duration).toBeGreaterThan(100);
    expect(report.duration).toBeLessThan(1500);
  });

  it("produces a monotonic, normalised easing curve", () => {
    const curve = createSpringEasing();
    expect(curve(0)).toBe(0);
    expect(curve(1)).toBe(1);
    expect(curve.duration).toBeGreaterThan(0);

    let previous = -1;
    for (let i = 0; i <= 40; i++) {
      const value = curve(i / 40);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = value;
    }
    expect(curve(0.5)).toBeGreaterThan(0.5);
  });

  it("settles faster with more stiffness and slower with more mass", () => {
    const base = springSettlingTime({ stiffness: 210, damping: 29, mass: 1 });
    const stiff = springSettlingTime({ stiffness: 420, damping: 41, mass: 1 });
    const heavy = springSettlingTime({ stiffness: 120, damping: 26, mass: 1.2 });
    expect(stiff).toBeLessThan(base);
    expect(heavy).toBeGreaterThan(base);
  });

  it("allows explicitly requested overshoot but reports it", () => {
    const bouncy = describeSpring({ stiffness: 180, damping: 12, mass: 1 });
    expect(bouncy.observable).toBe(true);
    expect(bouncy.overshoot).toBeGreaterThan(0.1);
    expect(bouncy.verdict).toBe("bouncy");
  });

  it("carries velocity through a retargeted SpringValue", () => {
    const value = new SpringValue(100, normalizeSpring());
    value.set(0, 600);
    const first = value.step(16);
    expect(first.value).toBeGreaterThan(0);
    expect(first.velocity).toBeGreaterThan(0);

    value.retarget(-40);
    let frames = 0;
    while (!value.step(16).settled && frames < 600) frames++;
    expect(frames).toBeLessThan(600);
    expect(value.value).toBeCloseTo(-40, 3);
  });
});

describe("easing", () => {
  it("ships the Waves curve tokens", () => {
    const names = listEasings().map((entry) => entry.name);
    expect(names).toContain("waves-standard");
    expect(names).toContain("waves-entrance");
    expect(names).toContain("waves-spring");
  });

  it("resolves named curves, beziers and springs with metadata", () => {
    const standard = resolveEasing("waves-standard");
    expect(standard.spring).toBe(false);
    expect(standard.points).toEqual([0.32, 0.72, 0, 1]);

    const spring = resolveEasing("waves-spring");
    expect(spring.spring).toBe(true);
    expect(spring.duration).toBeGreaterThan(0);

    const custom = resolveEasing([0.1, 0.2, 0.3, 0.4]);
    expect(custom.points).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("solves cubic beziers accurately at the endpoints and midpoints", () => {
    const ease = cubicBezier([0.25, 0.1, 0.25, 1]);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeGreaterThan(0.5);
    expect(ease(0.1)).toBeLessThan(ease(0.2));
  });

  it("approximates springs in CSS exports instead of dropping the curve", () => {
    expect(easingToCss("waves-standard")).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
    expect(easingToCss("waves-spring").startsWith("linear(")).toBe(true);
  });

  it("samples curves deterministically", () => {
    const a = sampleEasing("waves-entrance", 8);
    const b = sampleEasing("waves-entrance", 8);
    expect(a).toEqual(b);
    expect(a[0]).toBe(0);
    expect(a[a.length - 1]).toBe(1);
  });
});